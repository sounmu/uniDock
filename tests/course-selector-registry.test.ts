import { describe, expect, it } from "vitest";
import {
  COURSE_SELECTOR_TTL_MS,
  CourseSelectorRegistry,
} from "../src/course-selector-registry";

const scope = (value: number) =>
  `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;

describe("CourseSelectorRegistry", () => {
  it("issues reusable account/epoch-bound selectors that expire", () => {
    const registry = new CourseSelectorRegistry();
    const admission = registry.admit(scope(1), 100);
    const [course] = registry.publish(
      admission,
      [{ id: "12", name: "Course" }],
      "account-a",
      3,
      100,
    )!;

    expect(registry.resolve(course!.courseSelector, "account-a", 3, 101)).toBe(
      "12",
    );
    expect(registry.resolve(course!.courseSelector, "account-a", 3, 102)).toBe(
      "12",
    );
    expect(registry.resolve(course!.courseSelector, "account-b", 3, 102)).toBe(
      undefined,
    );
    expect(registry.resolve(course!.courseSelector, "account-a", 4, 102)).toBe(
      undefined,
    );
    expect(
      registry.resolve(
        course!.courseSelector,
        "account-a",
        3,
        100 + COURSE_SELECTOR_TTL_MS,
      ),
    ).toBeUndefined();
  });

  it("revokes only the refreshed issuer and rejects stale admissions", () => {
    const registry = new CourseSelectorRegistry();
    const old = registry.admit(scope(1), 0);
    const other = registry.admit(scope(2), 0);
    const oldSelector = registry.publish(
      old,
      [{ id: "1", name: "Same" }],
      "a",
      0,
      0,
    )![0]!.courseSelector;
    const otherSelector = registry.publish(
      other,
      [{ id: "2", name: "Same" }],
      "a",
      0,
      0,
    )![0]!.courseSelector;

    const replacement = registry.admit(scope(1), 1);
    expect(
      registry.publish(old, [{ id: "3", name: "Old" }], "a", 0, 0),
    ).toBeUndefined();
    expect(registry.resolve(oldSelector, "a", 0, 1)).toBeUndefined();
    expect(registry.resolve(otherSelector, "a", 0, 1)).toBe("2");
    expect(
      registry.publish(replacement, [{ id: "3", name: "New" }], "a", 0, 0),
    ).toHaveLength(1);
  });

  it("bounds issuers, one index, and global selectors", () => {
    const issuers = new CourseSelectorRegistry();
    for (let index = 0; index < 64; index++) issuers.admit(scope(index), 0);
    expect(() => issuers.admit(scope(64), 0)).toThrow("LIMIT");

    const registry = new CourseSelectorRegistry();
    const rows = Array.from({ length: 10_000 }, (_, index) => ({
      id: String(index + 1),
      name: "Course",
    }));
    for (let index = 0; index < 4; index++)
      expect(
        registry.publish(registry.admit(scope(index), 0), rows, "a", 0, 0),
      ).toHaveLength(10_000);
    expect(() =>
      registry.publish(
        registry.admit(scope(5), 0),
        [{ id: "40001", name: "Course" }],
        "a",
        0,
        0,
      ),
    ).toThrow("LIMIT");
  });

  it("reclaims expired completed issuers without dropping pending admissions", () => {
    const registry = new CourseSelectorRegistry();
    for (let index = 0; index < 64; index++) {
      const admission = registry.admit(scope(index), 0);
      registry.publish(
        admission,
        [{ id: String(index + 1), name: "Course" }],
        "a",
        0,
        0,
      );
    }
    expect(() => registry.admit(scope(64), 0)).toThrow("LIMIT");
    expect(() =>
      registry.admit(scope(64), COURSE_SELECTOR_TTL_MS),
    ).not.toThrow();

    const pending = new CourseSelectorRegistry();
    const stale = pending.admit(scope(1), 0);
    pending.admit(scope(2), COURSE_SELECTOR_TTL_MS);
    expect(
      pending.publish(stale, [{ id: "1", name: "Old" }], "a", 0, 0),
    ).toHaveLength(1);
  });

  it("keeps an empty published generation current until its TTL expires", () => {
    const registry = new CourseSelectorRegistry();
    const empty = registry.admit(scope(1), 0);
    expect(registry.publish(empty, [], "a", 0, 0)).toEqual([]);
    registry.admit(scope(2), 1);
    expect(registry.current(empty)).toBe(true);
    registry.admit(scope(3), COURSE_SELECTOR_TTL_MS);
    expect(registry.current(empty)).toBe(false);
  });
});
