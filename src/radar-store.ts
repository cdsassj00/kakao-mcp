import Database from "better-sqlite3";
import { randomBytes, randomUUID } from "node:crypto";

/** 정규화된 공고 레코드 */
export interface Notice {
  id: number;
  source: string; // 'LH'
  external_id: string; // 원천 공고 ID (PAN_ID)
  title: string;
  type_name: string; // 행복주택, 국민임대, 분양주택 …
  region: string; // 서울, 경기 …
  status: string; // 접수중, 공고중, 접수마감 …
  posted_on: string | null; // YYYY-MM-DD
  close_on: string | null; // YYYY-MM-DD (신청 마감)
  detail_url: string | null;
  fetched_at: string;
}

export interface NoticeInput {
  source: string;
  externalId: string;
  title: string;
  typeName?: string;
  region?: string;
  status?: string;
  postedOn?: string | null;
  closeOn?: string | null;
  detailUrl?: string | null;
}

export interface Profile {
  id: string;
  name: string;
  regions: string[];
  keywords: string[];
  types: string[];
}

export class RadarStore {
  private db: Database.Database;

  constructor(path: string = ":memory:") {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS notices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        external_id TEXT NOT NULL,
        title TEXT NOT NULL,
        type_name TEXT NOT NULL DEFAULT '',
        region TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT '',
        posted_on TEXT,
        close_on TEXT,
        detail_url TEXT,
        fetched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        UNIQUE (source, external_id)
      );
      CREATE INDEX IF NOT EXISTS idx_notices_close ON notices(close_on);
      CREATE TABLE IF NOT EXISTS profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        regions TEXT NOT NULL DEFAULT '[]',
        keywords TEXT NOT NULL DEFAULT '[]',
        types TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE TABLE IF NOT EXISTS config (
        k TEXT PRIMARY KEY,
        v TEXT NOT NULL
      );
    `);
  }

  /** 공고 upsert. 상태·마감일이 바뀌면 갱신한다. 반환: 신규 여부 */
  upsertNotice(input: NoticeInput): { isNew: boolean } {
    const existing = this.db
      .prepare("SELECT id FROM notices WHERE source = ? AND external_id = ?")
      .get(input.source, input.externalId) as { id: number } | undefined;
    this.db
      .prepare(
        `INSERT INTO notices (source, external_id, title, type_name, region, status, posted_on, close_on, detail_url)
         VALUES (@source, @externalId, @title, @typeName, @region, @status, @postedOn, @closeOn, @detailUrl)
         ON CONFLICT (source, external_id) DO UPDATE SET
           title = excluded.title, type_name = excluded.type_name, region = excluded.region,
           status = excluded.status, posted_on = excluded.posted_on, close_on = excluded.close_on,
           detail_url = excluded.detail_url, fetched_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
      )
      .run({
        source: input.source,
        externalId: input.externalId,
        title: input.title,
        typeName: input.typeName ?? "",
        region: input.region ?? "",
        status: input.status ?? "",
        postedOn: input.postedOn ?? null,
        closeOn: input.closeOn ?? null,
        detailUrl: input.detailUrl ?? null,
      });
    return { isNew: !existing };
  }

  searchNotices(filter: {
    regions?: string[];
    keywords?: string[];
    types?: string[];
    status?: string;
    closingWithinDays?: number;
    today?: string;
    limit?: number;
  }): Notice[] {
    const conditions: string[] = ["1=1"];
    const params: unknown[] = [];
    if (filter.regions?.length) {
      conditions.push(`(${filter.regions.map(() => "region LIKE ?").join(" OR ")})`);
      params.push(...filter.regions.map((r) => `%${r.trim()}%`));
    }
    if (filter.types?.length) {
      conditions.push(`(${filter.types.map(() => "type_name LIKE ?").join(" OR ")})`);
      params.push(...filter.types.map((t) => `%${t.trim()}%`));
    }
    if (filter.keywords?.length) {
      for (const keyword of filter.keywords) {
        conditions.push("(title LIKE ? OR type_name LIKE ? OR region LIKE ?)");
        const pattern = `%${keyword.trim()}%`;
        params.push(pattern, pattern, pattern);
      }
    }
    if (filter.status) {
      conditions.push("status LIKE ?");
      params.push(`%${filter.status}%`);
    }
    if (filter.closingWithinDays !== undefined && filter.today) {
      conditions.push("close_on IS NOT NULL AND close_on >= ? AND close_on <= ?");
      params.push(filter.today, addDays(filter.today, filter.closingWithinDays));
    }
    const limit = Math.min(Math.max(filter.limit ?? 10, 1), 50);
    return this.db
      .prepare(
        `SELECT * FROM notices WHERE ${conditions.join(" AND ")}
         ORDER BY COALESCE(close_on, '9999') ASC, posted_on DESC LIMIT ?`
      )
      .all(...params, limit) as Notice[];
  }

  getNotice(id: number): Notice | null {
    return (this.db.prepare("SELECT * FROM notices WHERE id = ?").get(id) as Notice | undefined) ?? null;
  }

  noticeStats(): { total: number; bySource: { source: string; count: number; lastFetched: string | null }[] } {
    const total = (this.db.prepare("SELECT COUNT(*) c FROM notices").get() as { c: number }).c;
    const bySource = this.db
      .prepare("SELECT source, COUNT(*) count, MAX(fetched_at) lastFetched FROM notices GROUP BY source")
      .all() as { source: string; count: number; lastFetched: string | null }[];
    return { total, bySource };
  }

  createProfile(name: string): Profile {
    const id = randomUUID();
    this.db.prepare("INSERT INTO profiles (id, name) VALUES (?, ?)").run(id, name);
    return this.getProfile(id)!;
  }

  getProfile(id: string): Profile | null {
    const row = this.db.prepare("SELECT * FROM profiles WHERE id = ?").get(id) as
      | { id: string; name: string; regions: string; keywords: string; types: string }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      regions: JSON.parse(row.regions),
      keywords: JSON.parse(row.keywords),
      types: JSON.parse(row.types),
    };
  }

  updateProfile(id: string, fields: { regions?: string[]; keywords?: string[]; types?: string[] }): Profile | null {
    const profile = this.getProfile(id);
    if (!profile) return null;
    this.db
      .prepare("UPDATE profiles SET regions = ?, keywords = ?, types = ? WHERE id = ?")
      .run(
        JSON.stringify(fields.regions ?? profile.regions),
        JSON.stringify(fields.keywords ?? profile.keywords),
        JSON.stringify(fields.types ?? profile.types),
        id
      );
    return this.getProfile(id);
  }

  deleteProfile(id: string): boolean {
    return this.db.prepare("DELETE FROM profiles WHERE id = ?").run(id).changes > 0;
  }

  getConfig(key: string): string | null {
    const row = this.db.prepare("SELECT v FROM config WHERE k = ?").get(key) as { v: string } | undefined;
    return row?.v ?? null;
  }

  setConfig(key: string, value: string) {
    this.db
      .prepare("INSERT INTO config (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v")
      .run(key, value);
  }

  /** 서비스키 최초 설정. 이미 있으면 관리 토큰이 일치해야 교체 가능 */
  configureServiceKey(serviceKey: string, adminToken?: string): { ok: boolean; adminToken?: string; error?: string } {
    const existing = this.getConfig("lh_service_key");
    if (existing) {
      const savedToken = this.getConfig("admin_token");
      if (!adminToken || adminToken !== savedToken) {
        return { ok: false, error: "이미 설정되어 있습니다. 교체하려면 최초 설정 때 받은 admin_token이 필요합니다." };
      }
      this.setConfig("lh_service_key", serviceKey);
      return { ok: true, adminToken: savedToken ?? undefined };
    }
    const token = randomBytes(24).toString("hex");
    this.setConfig("lh_service_key", serviceKey);
    this.setConfig("admin_token", token);
    return { ok: true, adminToken: token };
  }
}

function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
