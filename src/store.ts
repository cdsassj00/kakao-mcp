import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

export type MemoryKind = "note" | "promise" | "preference";

export interface Memory {
  id: number;
  box_id: string;
  person: string | null;
  kind: MemoryKind;
  content: string;
  tags: string[];
  happened_at: string | null;
  created_at: string;
}

export interface MemoryBox {
  id: string;
  name: string;
  created_at: string;
}

export interface PersonStat {
  person: string;
  count: number;
  last_at: string;
}

export interface ChatMessage {
  id: number;
  box_id: string;
  room: string;
  sender: string;
  sent_at: string | null;
  content: string;
}

export interface RoomStat {
  room: string;
  count: number;
  first_at: string | null;
  last_at: string | null;
}

interface MemoryRow {
  id: number;
  box_id: string;
  person: string | null;
  kind: MemoryKind;
  content: string;
  tags: string;
  happened_at: string | null;
  created_at: string;
}

const MAX_MEMORIES_PER_BOX = 5000;
const MAX_CONTENT_LENGTH = 4000;
const MAX_CHAT_MESSAGES_PER_BOX = 200_000;

export class MemoryStore {
  private db: Database.Database;

  constructor(path: string = ":memory:") {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS boxes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        box_id TEXT NOT NULL REFERENCES boxes(id) ON DELETE CASCADE,
        person TEXT,
        kind TEXT NOT NULL DEFAULT 'note' CHECK (kind IN ('note','promise','preference')),
        content TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        happened_at TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX IF NOT EXISTS idx_memories_box ON memories(box_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memories_person ON memories(box_id, person);
      CREATE TABLE IF NOT EXISTS chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        box_id TEXT NOT NULL REFERENCES boxes(id) ON DELETE CASCADE,
        room TEXT NOT NULL,
        sender TEXT NOT NULL,
        sent_at TEXT,
        content TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chat_box_room ON chat_messages(box_id, room, sent_at);
    `);
  }

  createBox(name: string): MemoryBox {
    const id = randomUUID();
    this.db.prepare("INSERT INTO boxes (id, name) VALUES (?, ?)").run(id, name);
    return this.getBox(id)!;
  }

  getBox(id: string): MemoryBox | null {
    const row = this.db.prepare("SELECT * FROM boxes WHERE id = ?").get(id) as MemoryBox | undefined;
    return row ?? null;
  }

  deleteBox(id: string): boolean {
    const result = this.db.prepare("DELETE FROM boxes WHERE id = ?").run(id);
    return result.changes > 0;
  }

  addMemory(input: {
    boxId: string;
    content: string;
    person?: string | null;
    kind?: MemoryKind;
    tags?: string[];
    happenedAt?: string | null;
  }): Memory {
    const content = input.content.trim();
    if (!content) throw new StoreError("기억할 내용이 비어 있습니다.");
    if (content.length > MAX_CONTENT_LENGTH) {
      throw new StoreError(`내용이 너무 깁니다 (최대 ${MAX_CONTENT_LENGTH}자). 요약해서 저장해 주세요.`);
    }
    const count = this.db
      .prepare("SELECT COUNT(*) AS c FROM memories WHERE box_id = ?")
      .get(input.boxId) as { c: number };
    if (count.c >= MAX_MEMORIES_PER_BOX) {
      throw new StoreError(`기억상자가 가득 찼습니다 (최대 ${MAX_MEMORIES_PER_BOX}건). 오래된 기억을 정리해 주세요.`);
    }
    const result = this.db
      .prepare(
        `INSERT INTO memories (box_id, person, kind, content, tags, happened_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.boxId,
        input.person?.trim() || null,
        input.kind ?? "note",
        content,
        JSON.stringify(input.tags ?? []),
        input.happenedAt ?? null
      );
    return this.getMemory(input.boxId, Number(result.lastInsertRowid))!;
  }

  getMemory(boxId: string, id: number): Memory | null {
    const row = this.db
      .prepare("SELECT * FROM memories WHERE box_id = ? AND id = ?")
      .get(boxId, id) as MemoryRow | undefined;
    return row ? toMemory(row) : null;
  }

  deleteMemory(boxId: string, id: number): boolean {
    const result = this.db.prepare("DELETE FROM memories WHERE box_id = ? AND id = ?").run(boxId, id);
    return result.changes > 0;
  }

  /**
   * 다중 토큰 AND 매칭 검색. 토큰이 person / content / tags 어디에든 걸리면 매칭.
   * 개인 기억상자 규모(수천 건)에서는 LIKE 스캔이 충분히 빠르고,
   * FTS 트라이그램의 한국어 2글자 토큰 미매칭 문제를 피한다.
   */
  search(input: {
    boxId: string;
    query?: string;
    person?: string;
    kind?: MemoryKind;
    limit?: number;
  }): Memory[] {
    const limit = Math.min(Math.max(input.limit ?? 10, 1), 50);
    const conditions: string[] = ["box_id = ?"];
    const params: unknown[] = [input.boxId];

    if (input.person) {
      conditions.push("person LIKE ? ESCAPE '\\'");
      params.push(`%${escapeLike(input.person.trim())}%`);
    }
    if (input.kind) {
      conditions.push("kind = ?");
      params.push(input.kind);
    }

    const tokens = (input.query ?? "")
      .split(/\s+/)
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 8);
    for (const token of tokens) {
      conditions.push("(content LIKE ? ESCAPE '\\' OR IFNULL(person,'') LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\')");
      const pattern = `%${escapeLike(token)}%`;
      params.push(pattern, pattern, pattern);
    }

    const rows = this.db
      .prepare(
        `SELECT * FROM memories WHERE ${conditions.join(" AND ")}
         ORDER BY COALESCE(happened_at, created_at) DESC, id DESC`
      )
      .all(...params) as MemoryRow[];

    if (tokens.length === 0) return rows.slice(0, limit).map(toMemory);

    // 토큰 출현 횟수 기반 단순 스코어링 + 최신순 보조 정렬
    const scored = rows.map((row, recency) => {
      let score = 0;
      const haystack = `${row.person ?? ""} ${row.content} ${row.tags}`;
      for (const token of tokens) {
        score += countOccurrences(haystack, token);
      }
      return { row, score, recency };
    });
    scored.sort((a, b) => b.score - a.score || a.recency - b.recency);
    return scored.slice(0, limit).map((s) => toMemory(s.row));
  }

  listPeople(boxId: string): PersonStat[] {
    return this.db
      .prepare(
        `SELECT person, COUNT(*) AS count, MAX(COALESCE(happened_at, created_at)) AS last_at
         FROM memories WHERE box_id = ? AND person IS NOT NULL
         GROUP BY person ORDER BY last_at DESC`
      )
      .all(boxId) as PersonStat[];
  }

  listByPerson(boxId: string, person: string, limit = 20): Memory[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM memories WHERE box_id = ? AND person LIKE ? ESCAPE '\\'
         ORDER BY COALESCE(happened_at, created_at) DESC, id DESC LIMIT ?`
      )
      .all(boxId, `%${escapeLike(person.trim())}%`, limit) as MemoryRow[];
    return rows.map(toMemory);
  }

  listPromises(boxId: string, person?: string): Memory[] {
    const conditions = ["box_id = ?", "kind = 'promise'"];
    const params: unknown[] = [boxId];
    if (person) {
      conditions.push("person LIKE ? ESCAPE '\\'");
      params.push(`%${escapeLike(person.trim())}%`);
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM memories WHERE ${conditions.join(" AND ")}
         ORDER BY COALESCE(happened_at, created_at) ASC`
      )
      .all(...params) as MemoryRow[];
    return rows.map(toMemory);
  }

  importChatMessages(
    boxId: string,
    room: string,
    messages: { sender: string; sentAt: string | null; content: string }[]
  ): { imported: number; total: number } {
    const roomName = room.trim();
    if (!roomName) throw new StoreError("채팅방 이름이 비어 있습니다.");
    const count = (
      this.db.prepare("SELECT COUNT(*) c FROM chat_messages WHERE box_id = ?").get(boxId) as { c: number }
    ).c;
    if (count + messages.length > MAX_CHAT_MESSAGES_PER_BOX) {
      throw new StoreError(
        `대화 보관함이 가득 찹니다 (최대 ${MAX_CHAT_MESSAGES_PER_BOX}건, 현재 ${count}건). 오래된 채팅방을 delete_chat_room으로 정리해 주세요.`
      );
    }
    const insert = this.db.prepare(
      "INSERT INTO chat_messages (box_id, room, sender, sent_at, content) VALUES (?, ?, ?, ?, ?)"
    );
    const insertAll = this.db.transaction(() => {
      for (const message of messages) {
        insert.run(boxId, roomName, message.sender, message.sentAt, message.content);
      }
    });
    insertAll();
    return { imported: messages.length, total: count + messages.length };
  }

  searchChat(input: {
    boxId: string;
    query?: string;
    room?: string;
    sender?: string;
    limit?: number;
  }): ChatMessage[] {
    const limit = Math.min(Math.max(input.limit ?? 10, 1), 50);
    const conditions: string[] = ["box_id = ?"];
    const params: unknown[] = [input.boxId];
    if (input.room) {
      conditions.push("room LIKE ? ESCAPE '\\'");
      params.push(`%${escapeLike(input.room.trim())}%`);
    }
    if (input.sender) {
      conditions.push("sender LIKE ? ESCAPE '\\'");
      params.push(`%${escapeLike(input.sender.trim())}%`);
    }
    const tokens = (input.query ?? "")
      .split(/\s+/)
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 8);
    for (const token of tokens) {
      conditions.push("(content LIKE ? ESCAPE '\\' OR sender LIKE ? ESCAPE '\\')");
      const pattern = `%${escapeLike(token)}%`;
      params.push(pattern, pattern);
    }
    return this.db
      .prepare(
        `SELECT * FROM chat_messages WHERE ${conditions.join(" AND ")}
         ORDER BY COALESCE(sent_at, '') DESC, id DESC LIMIT ?`
      )
      .all(...params, limit) as ChatMessage[];
  }

  /** 특정 메시지 전후의 대화 흐름을 함께 조회 (검색 결과의 맥락 확인용) */
  chatContext(boxId: string, messageId: number, around = 5): ChatMessage[] {
    const target = this.db
      .prepare("SELECT * FROM chat_messages WHERE box_id = ? AND id = ?")
      .get(boxId, messageId) as ChatMessage | undefined;
    if (!target) return [];
    return this.db
      .prepare(
        `SELECT * FROM chat_messages WHERE box_id = ? AND room = ? AND id BETWEEN ? AND ? ORDER BY id ASC`
      )
      .all(boxId, target.room, messageId - around, messageId + around) as ChatMessage[];
  }

  listRooms(boxId: string): RoomStat[] {
    return this.db
      .prepare(
        `SELECT room, COUNT(*) AS count, MIN(sent_at) AS first_at, MAX(sent_at) AS last_at
         FROM chat_messages WHERE box_id = ? GROUP BY room ORDER BY last_at DESC`
      )
      .all(boxId) as RoomStat[];
  }

  deleteRoom(boxId: string, room: string): number {
    const result = this.db
      .prepare("DELETE FROM chat_messages WHERE box_id = ? AND room = ?")
      .run(boxId, room.trim());
    return result.changes;
  }

  exportAll(boxId: string): { box: MemoryBox; memories: Memory[] } | null {
    const box = this.getBox(boxId);
    if (!box) return null;
    const rows = this.db
      .prepare("SELECT * FROM memories WHERE box_id = ? ORDER BY id ASC")
      .all(boxId) as MemoryRow[];
    return { box, memories: rows.map(toMemory) };
  }

  chatCount(boxId: string): number {
    return (this.db.prepare("SELECT COUNT(*) c FROM chat_messages WHERE box_id = ?").get(boxId) as { c: number }).c;
  }

  stats(boxId: string): { total: number; byKind: Record<string, number>; people: number } {
    const total = (this.db.prepare("SELECT COUNT(*) c FROM memories WHERE box_id = ?").get(boxId) as { c: number }).c;
    const kindRows = this.db
      .prepare("SELECT kind, COUNT(*) c FROM memories WHERE box_id = ? GROUP BY kind")
      .all(boxId) as { kind: string; c: number }[];
    const people = (
      this.db
        .prepare("SELECT COUNT(DISTINCT person) c FROM memories WHERE box_id = ? AND person IS NOT NULL")
        .get(boxId) as { c: number }
    ).c;
    return {
      total,
      byKind: Object.fromEntries(kindRows.map((r) => [r.kind, r.c])),
      people,
    };
  }

  close() {
    this.db.close();
  }
}

export class StoreError extends Error {}

function toMemory(row: MemoryRow): Memory {
  return { ...row, tags: JSON.parse(row.tags) as string[] };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}
