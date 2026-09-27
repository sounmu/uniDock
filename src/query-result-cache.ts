import type { Result } from "./protocol";

export type CacheableResult = Extract<
  Result,
  | { courses: unknown[] }
  | { assignments: unknown[] }
  | { deadlines: unknown[] }
  | { upcoming: unknown[] }
  | { todo: unknown[] }
>;

interface CacheEntry {
  result: CacheableResult;
  rows: number;
  expiresAt: number;
}

const MAX_ENTRIES = 12;
const MAX_TOTAL_ROWS = 20_000;
const MAX_ENTRY_ROWS = 5_000;
const CACHEABLE_KEYS = [
  "courses",
  "assignments",
  "deadlines",
  "upcoming",
  "todo",
] as const;

function isCacheableResult(result: Result): result is CacheableResult {
  if (result.status !== "success" || Object.keys(result).length !== 2)
    return false;
  return CACHEABLE_KEYS.some((key) => Object.hasOwn(result, key));
}

function rowCount(result: CacheableResult): number {
  if ("courses" in result) return result.courses.length;
  if ("assignments" in result) return result.assignments.length;
  if ("deadlines" in result) return result.deadlines.length;
  if ("upcoming" in result) return result.upcoming.length;
  return result.todo.length;
}

function copyResult(result: CacheableResult): CacheableResult {
  if ("courses" in result)
    return { status: "success", courses: [...result.courses] };
  if ("assignments" in result)
    return { status: "success", assignments: [...result.assignments] };
  if ("deadlines" in result)
    return { status: "success", deadlines: [...result.deadlines] };
  if ("upcoming" in result)
    return { status: "success", upcoming: [...result.upcoming] };
  return { status: "success", todo: [...result.todo] };
}

/** Bounded, content-script-memory-only cache for capability-free list results. */
export class QueryResultCache {
  private entries = new Map<string, CacheEntry>();
  private totalRows = 0;

  get(key: string, now = Date.now()): CacheableResult | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now) {
      this.remove(key, entry);
      return undefined;
    }

    // Map insertion order is the LRU order; reinsert on access.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return copyResult(entry.result);
  }

  set(key: string, result: Result, ttlMs: number, now = Date.now()): boolean {
    const previous = this.entries.get(key);
    if (previous) this.remove(key, previous);
    this.removeExpired(now);

    const expiresAt = now + ttlMs;
    if (
      !isCacheableResult(result) ||
      rowCount(result) > MAX_ENTRY_ROWS ||
      !Number.isFinite(ttlMs) ||
      ttlMs <= 0 ||
      !Number.isFinite(expiresAt)
    )
      return false;

    const entry: CacheEntry = {
      result: copyResult(result),
      rows: rowCount(result),
      expiresAt,
    };
    this.entries.set(key, entry);
    this.totalRows += entry.rows;
    this.evictToLimits();
    return this.entries.has(key);
  }

  clear(): void {
    this.entries.clear();
    this.totalRows = 0;
  }

  private remove(key: string, entry: CacheEntry): void {
    if (!this.entries.delete(key)) return;
    this.totalRows -= entry.rows;
  }

  private removeExpired(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.remove(key, entry);
    }
  }

  private evictToLimits(): void {
    while (this.entries.size > MAX_ENTRIES || this.totalRows > MAX_TOTAL_ROWS) {
      const oldest = this.entries.entries().next().value;
      if (!oldest) return;
      this.remove(oldest[0], oldest[1]);
    }
  }
}
