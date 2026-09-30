import { describe, expect, it } from "vitest";
import type { Result } from "../src/protocol";
import { QueryResultCache } from "../src/query-result-cache";

const rows = (count: number): Result => ({
  status: "success",
  deadlines: Array.from({ length: count }, (_, index) => ({
    title: `Course ${index}`,
    due_at: "",
    remaining_candidate: false,
  })),
});

describe("QueryResultCache", () => {
  it.each([
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
    { status: "success", courses: [] },
    { status: "error", code: "NETWORK" },
  ] satisfies Result[])("does not cache %j", (result) => {
    const cache = new QueryResultCache();
    cache.set("key", rows(1), 1_000, 0);
    expect(cache.set("key", result, 1_000, 0)).toBe(false);
    expect(cache.get("key", 1)).toBeUndefined();
  });

  it("expires each entry using its caller-supplied TTL", () => {
    const cache = new QueryResultCache();
    cache.set("short", rows(1), 10, 100);
    cache.set("long", rows(1), 20, 100);

    expect(cache.get("short", 109)).toBeDefined();
    expect(cache.get("short", 110)).toBeUndefined();
    expect(cache.get("long", 119)).toBeDefined();
    expect(cache.get("long", 120)).toBeUndefined();
    expect(cache.set("invalid", rows(1), 0, 100)).toBe(false);
  });

  it("evicts the least recently used entry above 12 entries", () => {
    const cache = new QueryResultCache();
    for (let index = 0; index < 12; index += 1)
      cache.set(`key-${index}`, rows(1), 1_000, 0);

    expect(cache.get("key-0", 1)).toBeDefined();
    cache.set("key-12", rows(1), 1_000, 1);

    expect(cache.get("key-1", 2)).toBeUndefined();
    expect(cache.get("key-0", 2)).toBeDefined();
    expect(cache.get("key-12", 2)).toBeDefined();
  });

  it("enforces per-entry and total row limits with LRU eviction", () => {
    const cache = new QueryResultCache();
    expect(cache.set("too-large", rows(5_001), 1_000, 0)).toBe(false);

    for (let index = 0; index < 4; index += 1)
      expect(cache.set(`full-${index}`, rows(5_000), 1_000, 0)).toBe(true);
    expect(cache.get("full-0", 1)).toBeDefined();
    expect(cache.set("extra", rows(1), 1_000, 1)).toBe(true);

    expect(cache.get("full-1", 2)).toBeUndefined();
    expect(cache.get("full-0", 2)).toBeDefined();
    expect(cache.get("extra", 2)).toBeDefined();
  });

  it("deletes only the selected entry and releases its row capacity", () => {
    const cache = new QueryResultCache();
    for (let index = 0; index < 4; index += 1)
      expect(cache.set(`full-${index}`, rows(5_000), 1_000, 0)).toBe(true);

    expect(cache.delete("missing")).toBe(false);
    expect(cache.delete("full-1")).toBe(true);
    expect(cache.get("full-1", 1)).toBeUndefined();
    expect(cache.set("replacement", rows(5_000), 1_000, 1)).toBe(true);

    expect(cache.get("full-0", 2)).toBeDefined();
    expect(cache.get("full-2", 2)).toBeDefined();
    expect(cache.get("full-3", 2)).toBeDefined();
    expect(cache.get("replacement", 2)).toBeDefined();
  });

  it("clears all in-memory results and isolates cached arrays", () => {
    const cache = new QueryResultCache();
    const result = rows(1);
    cache.set("rows", result, 1_000, 0);
    if (result.status === "success" && "deadlines" in result)
      result.deadlines.push({
        title: "Mutated input",
        due_at: "",
        remaining_candidate: false,
      });

    const first = cache.get("rows", 1);
    expect(first && "deadlines" in first ? first.deadlines : []).toHaveLength(
      1,
    );
    if (first && "deadlines" in first)
      first.deadlines.push({
        title: "Mutated output",
        due_at: "",
        remaining_candidate: false,
      });
    const second = cache.get("rows", 2);
    expect(
      second && "deadlines" in second ? second.deadlines : [],
    ).toHaveLength(1);

    cache.clear();
    expect(cache.get("rows", 3)).toBeUndefined();
  });

  it("stores only internal course indices under the shared row budget", () => {
    const cache = new QueryResultCache();
    const courses = Array.from({ length: 10_000 }, (_, index) => ({
      id: String(index + 1),
      name: `Course ${index}`,
    }));
    expect(cache.setCourseIndex("index", courses, 1_000, 0)).toBe(true);
    courses[0]!.name = "mutated input";
    const first = cache.getCourseIndex("index", 1)!;
    expect(first[0]!.name).toBe("Course 0");
    first[0]!.name = "mutated output";
    expect(cache.getCourseIndex("index", 2)?.[0]?.name).toBe("Course 0");

    expect(cache.set("rows-a", rows(5_000), 1_000, 0)).toBe(true);
    expect(cache.set("rows-b", rows(5_000), 1_000, 0)).toBe(true);
    expect(cache.set("extra", rows(1), 1_000, 1)).toBe(true);
    expect(cache.get("rows-a", 2)).toBeUndefined();
    expect(cache.getCourseIndex("index", 2)).toHaveLength(10_000);
  });
});
