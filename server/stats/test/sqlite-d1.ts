import { DatabaseSync } from "node:sqlite";
import type { D1Database, D1PreparedStatement, D1Result } from "../src/d1.ts";

type SqlValue = null | number | bigint | string | Uint8Array;

class SqliteStatement implements D1PreparedStatement {
  readonly #db: DatabaseSync;
  readonly #sql: string;
  readonly #params: SqlValue[];

  constructor(db: DatabaseSync, sql: string, params: SqlValue[] = []) {
    this.#db = db;
    this.#sql = sql;
    this.#params = params;
  }

  bind(...values: unknown[]): D1PreparedStatement {
    return new SqliteStatement(this.#db, this.#sql, values as SqlValue[]);
  }

  runSync(): D1Result {
    const info = this.#db.prepare(this.#sql).run(...this.#params);
    return {
      success: true,
      results: [],
      meta: { changes: Number(info.changes) },
    };
  }

  async run(): Promise<D1Result> {
    return this.runSync();
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const rows = this.#db.prepare(this.#sql).all(...this.#params);
    return { success: true, results: rows.map((row) => ({ ...row }) as T) };
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const row = this.#db.prepare(this.#sql).get(...this.#params);
    return row ? ({ ...row } as T) : null;
  }
}

export interface SqliteD1 extends D1Database {
  exec(sql: string): void;
  close(): void;
}

export function createSqliteD1(path = ":memory:"): SqliteD1 {
  const db = new DatabaseSync(path);
  return {
    prepare: (sql) => new SqliteStatement(db, sql),
    async batch(statements) {
      db.exec("BEGIN");
      try {
        const results = statements.map((statement) => {
          if (!(statement instanceof SqliteStatement))
            throw new Error("FOREIGN_STATEMENT");
          return statement.runSync();
        });
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    exec: (sql) => db.exec(sql),
    close: () => db.close(),
  };
}
