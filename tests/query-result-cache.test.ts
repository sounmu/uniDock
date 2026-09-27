import { describe, expect, it } from "vitest";
import type { Result } from "../src/protocol";
import { QueryResultCache } from "../src/query-result-cache";

const courses = (count: number): Result => ({
  status: "success",
  courses: Array.from({ length: count }, (_, index) => ({
    name: `Course ${index}`,
  })),
});

describe("QueryResultCache", () => {
  it.each([
    ["courses", { status: "success", courses: [] }],
    ["assignments", { status: "success", assignments: [] }],
    ["deadlines", { status: "success", deadlines: [] }],
    ["upcoming", { status: "success", upcoming: [] }],
    ["todo", { status: "success", todo: [] }],
  ] satisfies [string, Result][])(
    "caches capability-free %s lists",
    (key, result) => {
      const cache = new QueryResultCache();
      expect(cache.set(key, result, 1_000, 100)).toBe(true);
      expect(cache.get(key, 101)).toEqual(result);
    },
  );

  it.each([
    { status: "success", recordings: [] },
    { status: "success", documents: [] },
    { status: "success", opened: true },
    { status: "success", downloaded: true },
    { status: "error", code: "NETWORK" },
  ] satisfies Result[])("does not cache %j", (result) => {
    const cache = new QueryResultCache();
    cache.set("key", courses(1), 1_000, 0);
    expect(cache.set("key", result, 1_000, 0)).toBe(false);
    expect(cache.get("key", 1)).toBeUndefined();
  });

  it("expires each entry using its caller-supplied TTL", () => {
    const cache = new QueryResultCache();
    cache.set("short", courses(1), 10, 100);
    cache.set("long", courses(1), 20, 100);

    expect(cache.get("short", 109)).toBeDefined();
    expect(cache.get("short", 110)).toBeUndefined();
    expect(cache.get("long", 119)).toBeDefined();
    expect(cache.get("long", 120)).toBeUndefined();
    expect(cache.set("invalid", courses(1), 0, 100)).toBe(false);
  });

  it("evicts the least recently used entry above 12 entries", () => {
    const cache = new QueryResultCache();
    for (let index = 0; index < 12; index += 1)
      cache.set(`key-${index}`, courses(1), 1_000, 0);

    expect(cache.get("key-0", 1)).toBeDefined();
    cache.set("key-12", courses(1), 1_000, 1);

    expect(cache.get("key-1", 2)).toBeUndefined();
    expect(cache.get("key-0", 2)).toBeDefined();
    expect(cache.get("key-12", 2)).toBeDefined();
  });

  it("enforces per-entry and total row limits with LRU eviction", () => {
    const cache = new QueryResultCache();
    expect(cache.set("too-large", courses(5_001), 1_000, 0)).toBe(false);

    for (let index = 0; index < 4; index += 1)
      expect(cache.set(`full-${index}`, courses(5_000), 1_000, 0)).toBe(true);
    expect(cache.get("full-0", 1)).toBeDefined();
    expect(cache.set("extra", courses(1), 1_000, 1)).toBe(true);

    expect(cache.get("full-1", 2)).toBeUndefined();
    expect(cache.get("full-0", 2)).toBeDefined();
    expect(cache.get("extra", 2)).toBeDefined();
  });

  it("deletes only the selected entry and releases its row capacity", () => {
    const cache = new QueryResultCache();
    for (let index = 0; index < 4; index += 1)
      expect(cache.set(`full-${index}`, courses(5_000), 1_000, 0)).toBe(true);

    expect(cache.delete("missing")).toBe(false);
    expect(cache.delete("full-1")).toBe(true);
    expect(cache.get("full-1", 1)).toBeUndefined();
    expect(cache.set("replacement", courses(5_000), 1_000, 1)).toBe(true);

    expect(cache.get("full-0", 2)).toBeDefined();
    expect(cache.get("full-2", 2)).toBeDefined();
    expect(cache.get("full-3", 2)).toBeDefined();
    expect(cache.get("replacement", 2)).toBeDefined();
  });

  it("clears all in-memory results and isolates cached arrays", () => {
    const cache = new QueryResultCache();
    const result = courses(1);
    cache.set("courses", result, 1_000, 0);
    if (result.status === "success" && "courses" in result)
      result.courses.push({ name: "Mutated input" });

    const first = cache.get("courses", 1);
    expect(first && "courses" in first ? first.courses : []).toHaveLength(1);
    if (first && "courses" in first)
      first.courses.push({ name: "Mutated output" });
    const second = cache.get("courses", 2);
    expect(second && "courses" in second ? second.courses : []).toHaveLength(1);

    cache.clear();
    expect(cache.get("courses", 3)).toBeUndefined();
  });
});
