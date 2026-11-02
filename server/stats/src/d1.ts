// Minimal structural subset of the Cloudflare D1 API used by the collector.
// Kept local so the repository needs no @cloudflare/workers-types dependency;
// the real D1Database binding satisfies it structurally.

export interface D1Meta {
  changes?: number;
}
export interface D1Result<T = Record<string, unknown>> {
  success: boolean;
  results: T[];
  meta?: D1Meta;
}
export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  run(): Promise<D1Result>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}
export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  /** Runs the statements in one implicit transaction; any failure rolls all back. */
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>;
}
