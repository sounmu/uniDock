import type { Result } from "./protocol";
import type { InternalCourse } from "./domain";

export type CacheableResult = Extract<
  Result,
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
interface CourseIndexEntry {
  courses: InternalCourse[];
  rows: number;
  expiresAt: number;
}

const MAX_ENTRIES = 12;
const MAX_TOTAL_ROWS = 20_000;
const MAX_ENTRY_ROWS = 5_000;
const CACHEABLE_KEYS = [
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
  if ("assignments" in result) return result.assignments.length;
  if ("deadlines" in result) return result.deadlines.length;
  if ("upcoming" in result) return result.upcoming.length;
  return result.todo.length;
}

function copyResult(result: CacheableResult): CacheableResult {
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
  private courseIndexes = new Map<string, CourseIndexEntry>();
  private totalRows = 0;

  get(key: string, now = Date.now()): CacheableResult | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now) {
      this.removeEntry(key, entry);
      return undefined;
    }

    // Map insertion order is the LRU order; reinsert on access.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return copyResult(entry.result);
  }

  getCourseIndex(key: string, now = Date.now()): InternalCourse[] | undefined {
    const entry = this.courseIndexes.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now) {
      this.removeCourseIndex(key, entry);
      return undefined;
    }
    this.courseIndexes.delete(key);
    this.courseIndexes.set(key, entry);
    return entry.courses.map((course) => ({ ...course }));
  }

  setCourseIndex(
    key: string,
    courses: readonly InternalCourse[],
    ttlMs: number,
    now = Date.now(),
  ): boolean {
    const previous = this.courseIndexes.get(key);
    if (previous) this.removeCourseIndex(key, previous);
    this.removeExpired(now);
    const expiresAt = now + ttlMs;
    if (
      courses.length > 10_000 ||
      !Number.isFinite(ttlMs) ||
      ttlMs <= 0 ||
      !Number.isFinite(expiresAt)
    )
      return false;
    const entry = {
      courses: courses.map((course) => ({ ...course })),
      rows: courses.length,
      expiresAt,
    };
    this.courseIndexes.set(key, entry);
    this.totalRows += entry.rows;
    this.evictToLimits();
    return this.courseIndexes.has(key);
  }

  set(key: string, result: Result, ttlMs: number, now = Date.now()): boolean {
    const previous = this.entries.get(key);
    if (previous) this.removeEntry(key, previous);
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

  delete(key: string): boolean {
    const courseIndex = this.courseIndexes.get(key);
    if (courseIndex) {
      this.removeCourseIndex(key, courseIndex);
      return true;
    }
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.removeEntry(key, entry);
    return true;
  }

  clear(): void {
    this.entries.clear();
    this.courseIndexes.clear();
    this.totalRows = 0;
  }

  private removeEntry(key: string, entry: CacheEntry): void {
    if (!this.entries.delete(key)) return;
    this.totalRows -= entry.rows;
  }

  private removeExpired(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.removeEntry(key, entry);
    }
    for (const [key, entry] of this.courseIndexes) {
      if (entry.expiresAt <= now) this.removeCourseIndex(key, entry);
    }
  }

  private evictToLimits(): void {
    while (
      this.entries.size + this.courseIndexes.size > MAX_ENTRIES ||
      this.totalRows > MAX_TOTAL_ROWS
    ) {
      const regular = this.entries.entries().next().value;
      const course = this.courseIndexes.entries().next().value;
      if (regular) this.removeEntry(regular[0], regular[1]);
      else if (course) this.removeCourseIndex(course[0], course[1]);
      else return;
    }
  }

  private removeCourseIndex(key: string, entry: CourseIndexEntry): void {
    if (!this.courseIndexes.delete(key)) return;
    this.totalRows -= entry.rows;
  }
}
