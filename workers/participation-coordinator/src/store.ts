// Storage adapter — one interface, two backends.
//
//   D1Store    — Cloudflare D1 (production, Workers)
//   SqliteStore— node:sqlite (local dev + tests)
//
// The SQL in the operations layer is written once against this interface so
// local/prod behavior cannot drift.
export interface Db {
  /** Run a statement, return rows (SELECT) or []. */
  all<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Run a statement returning the first row or null. */
  get<T = unknown>(sql: string, params?: unknown[]): Promise<T | null>;
  /** Execute a mutating statement. */
  run(sql: string, params?: unknown[]): Promise<void>;
  /** Execute non-parameterized DDL (multi-statement schema). */
  exec(sql: string): Promise<void>;
}

export class D1Store implements Db {
  constructor(private db: D1Database) {}
  async all<T>(sql: string, params: unknown[] = []) {
    const r = await this.db.prepare(sql).bind(...params).all<T>();
    return (r.results ?? []) as T[];
  }
  async get<T>(sql: string, params: unknown[] = []) {
    return (await this.db.prepare(sql).bind(...params).first<T>()) ?? null;
  }
  async run(sql: string, params: unknown[] = []) {
    await this.db.prepare(sql).bind(...params).run();
  }
  async exec(sql: string) {
    await this.db.exec(sql);
  }
}

// node:sqlite binding, loaded lazily so the Worker bundle never imports it.
export class SqliteStore implements Db {
  private db: any;
  static async open(path = ":memory:"): Promise<SqliteStore> {
    const { DatabaseSync } = await import("node:sqlite");
    const s = new SqliteStore();
    s.db = new DatabaseSync(path);
    return s;
  }
  async all<T>(sql: string, params: unknown[] = []) {
    return this.db.prepare(sql).all(...params) as T[];
  }
  async get<T>(sql: string, params: unknown[] = []) {
    return (this.db.prepare(sql).get(...params) as T) ?? null;
  }
  async run(sql: string, params: unknown[] = []) {
    this.db.prepare(sql).run(...params);
  }
  async exec(sql: string) {
    this.db.exec(sql);
  }
}
