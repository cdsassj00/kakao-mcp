import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

export type EntryKind = "expense" | "income";

export interface LedgerEntry {
  id: number;
  box_id: string;
  kind: EntryKind;
  amount: number;
  category: string;
  memo: string | null;
  spent_on: string; // YYYY-MM-DD
  created_at: string;
}

export interface Budget {
  category: string | null; // null = 전체 예산
  monthly_amount: number;
}

export interface CategorySum {
  category: string;
  total: number;
  count: number;
}

const MAX_ENTRIES_PER_BOX = 100_000;

export class LedgerStore {
  private db: Database.Database;

  constructor(path: string = ":memory:") {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ledgers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE TABLE IF NOT EXISTS entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        box_id TEXT NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
        kind TEXT NOT NULL DEFAULT 'expense' CHECK (kind IN ('expense','income')),
        amount INTEGER NOT NULL CHECK (amount > 0),
        category TEXT NOT NULL,
        memo TEXT,
        spent_on TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX IF NOT EXISTS idx_entries_box_month ON entries(box_id, spent_on);
      CREATE TABLE IF NOT EXISTS budgets (
        box_id TEXT NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
        -- ''(빈 문자열) = 전체 예산. SQLite UNIQUE에서 NULL은 중복 허용이라 센티널을 쓴다.
        category TEXT NOT NULL DEFAULT '',
        monthly_amount INTEGER NOT NULL CHECK (monthly_amount > 0),
        UNIQUE (box_id, category)
      );
    `);
  }

  createLedger(name: string): { id: string; name: string } {
    const id = randomUUID();
    this.db.prepare("INSERT INTO ledgers (id, name) VALUES (?, ?)").run(id, name);
    return { id, name };
  }

  getLedger(id: string): { id: string; name: string } | null {
    return (this.db.prepare("SELECT id, name FROM ledgers WHERE id = ?").get(id) as { id: string; name: string } | undefined) ?? null;
  }

  deleteLedger(id: string): boolean {
    return this.db.prepare("DELETE FROM ledgers WHERE id = ?").run(id).changes > 0;
  }

  addEntry(input: {
    boxId: string;
    amount: number;
    category: string;
    memo?: string | null;
    spentOn: string;
    kind?: EntryKind;
  }): LedgerEntry {
    if (!Number.isInteger(input.amount) || input.amount <= 0) {
      throw new LedgerError("금액은 1원 이상의 정수여야 합니다.");
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.spentOn)) {
      throw new LedgerError("날짜는 YYYY-MM-DD 형식이어야 합니다.");
    }
    const count = (this.db.prepare("SELECT COUNT(*) c FROM entries WHERE box_id = ?").get(input.boxId) as { c: number }).c;
    if (count >= MAX_ENTRIES_PER_BOX) {
      throw new LedgerError(`가계부가 가득 찼습니다 (최대 ${MAX_ENTRIES_PER_BOX}건).`);
    }
    const result = this.db
      .prepare("INSERT INTO entries (box_id, kind, amount, category, memo, spent_on) VALUES (?, ?, ?, ?, ?, ?)")
      .run(input.boxId, input.kind ?? "expense", input.amount, input.category.trim() || "기타", input.memo?.trim() || null, input.spentOn);
    return this.db.prepare("SELECT * FROM entries WHERE id = ?").get(Number(result.lastInsertRowid)) as LedgerEntry;
  }

  deleteEntry(boxId: string, id: number): boolean {
    return this.db.prepare("DELETE FROM entries WHERE box_id = ? AND id = ?").run(boxId, id).changes > 0;
  }

  listEntries(boxId: string, month?: string, category?: string, limit = 20): LedgerEntry[] {
    const conditions = ["box_id = ?"];
    const params: unknown[] = [boxId];
    if (month) {
      conditions.push("spent_on LIKE ?");
      params.push(`${month}-%`);
    }
    if (category) {
      conditions.push("category = ?");
      params.push(category.trim());
    }
    return this.db
      .prepare(`SELECT * FROM entries WHERE ${conditions.join(" AND ")} ORDER BY spent_on DESC, id DESC LIMIT ?`)
      .all(...params, Math.min(Math.max(limit, 1), 100)) as LedgerEntry[];
  }

  /** 월별 합계: 지출 총액, 수입 총액, 카테고리별 지출 */
  monthlySummary(boxId: string, month: string): {
    expenseTotal: number;
    incomeTotal: number;
    count: number;
    byCategory: CategorySum[];
  } {
    const totals = this.db
      .prepare(
        `SELECT kind, SUM(amount) total, COUNT(*) c FROM entries
         WHERE box_id = ? AND spent_on LIKE ? GROUP BY kind`
      )
      .all(boxId, `${month}-%`) as { kind: EntryKind; total: number; c: number }[];
    const byCategory = this.db
      .prepare(
        `SELECT category, SUM(amount) total, COUNT(*) count FROM entries
         WHERE box_id = ? AND spent_on LIKE ? AND kind = 'expense'
         GROUP BY category ORDER BY total DESC`
      )
      .all(boxId, `${month}-%`) as CategorySum[];
    const expense = totals.find((t) => t.kind === "expense");
    const income = totals.find((t) => t.kind === "income");
    return {
      expenseTotal: expense?.total ?? 0,
      incomeTotal: income?.total ?? 0,
      count: (expense?.c ?? 0) + (income?.c ?? 0),
      byCategory,
    };
  }

  categoryMonthTotal(boxId: string, month: string, category: string): number {
    const row = this.db
      .prepare(
        "SELECT SUM(amount) total FROM entries WHERE box_id = ? AND spent_on LIKE ? AND category = ? AND kind = 'expense'"
      )
      .get(boxId, `${month}-%`, category) as { total: number | null };
    return row.total ?? 0;
  }

  setBudget(boxId: string, monthlyAmount: number, category?: string | null) {
    if (!Number.isInteger(monthlyAmount) || monthlyAmount <= 0) {
      throw new LedgerError("예산은 1원 이상의 정수여야 합니다.");
    }
    this.db
      .prepare(
        `INSERT INTO budgets (box_id, category, monthly_amount) VALUES (?, ?, ?)
         ON CONFLICT (box_id, category) DO UPDATE SET monthly_amount = excluded.monthly_amount`
      )
      .run(boxId, category?.trim() || "", monthlyAmount);
  }

  budgets(boxId: string): Budget[] {
    const rows = this.db
      .prepare("SELECT category, monthly_amount FROM budgets WHERE box_id = ? ORDER BY category")
      .all(boxId) as { category: string; monthly_amount: number }[];
    return rows.map((r) => ({ category: r.category || null, monthly_amount: r.monthly_amount }));
  }

  exportAll(boxId: string): { entries: LedgerEntry[]; budgets: Budget[] } {
    return {
      entries: this.db.prepare("SELECT * FROM entries WHERE box_id = ? ORDER BY id ASC").all(boxId) as LedgerEntry[],
      budgets: this.budgets(boxId),
    };
  }
}

export class LedgerError extends Error {}
