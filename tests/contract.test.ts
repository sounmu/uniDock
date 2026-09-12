import { describe, expect, it, vi } from "vitest";
import fixture from "./fixtures/python-contract.json";
import { listQuery } from "../src/api/client";
import {
  projectAssignments,
  projectDeadlines,
  projectUpcoming,
  projectTodo,
  remainingCandidate,
} from "../src/domain-items";
import { parseResult, type Request } from "../src/protocol";
const origin = "https://mylms.korea.ac.kr";
const now = Date.parse(fixture.provenance.now);
const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
for (const [name, data] of [
  ["original Python FakeSession", fixture],
  ["Python-evaluated edge cases", fixture.edge],
] as const) {
  describe(name, () => {
    it("matches every assignment field and default", () =>
      expect(projectAssignments(data.raw.assignments, now)).toEqual(
        data.expected.assignments,
      ));
    it("matches all deadline rows without filtering or sorting", () =>
      expect(
        projectDeadlines(projectAssignments(data.raw.assignments, now)),
      ).toEqual(data.expected.deadlines));
    it("matches upcoming title/date fallbacks and submission state", () =>
      expect(projectUpcoming(data.raw.upcoming)).toEqual(
        data.expected.upcoming,
      ));
    it("matches todo title/due date/ignore without mutations", () =>
      expect(projectTodo(data.raw.todo)).toEqual(data.expected.todo));
    it.each(["assignments", "deadlines", "upcoming", "todo"] as const)(
      "preserves %s contract through message validation",
      (key) => {
        const result = { status: "success", [key]: data.expected[key] };
        expect(parseResult(result)).toEqual(result);
      },
    );
  });
}
it.each(fixture.remaining)(
  "matches Python remaining-candidate assertion $args",
  ({ args, expected }) => {
    const [due, locked, submitted, workflow] = args as [
      string,
      boolean,
      string,
      string,
    ];
    expect(remainingCandidate(due, locked, submitted, workflow, now)).toBe(
      expected,
    );
  },
);
const queries: [Request, keyof typeof fixture.expected][] = [
  [{ version: 1, type: "ASSIGNMENTS_LIST", course: "국제법" }, "assignments"],
  [{ version: 1, type: "DEADLINES_LIST", course: "국제법" }, "deadlines"],
  [{ version: 1, type: "UPCOMING_LIST" }, "upcoming"],
  [{ version: 1, type: "TODO_LIST" }, "todo"],
];
it.each(queries)(
  "matches Python fixture end-to-end: %j",
  async (request, key) => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/api/v1/courses") return json(fixture.raw.courses);
      if (path === "/api/v1/courses/101/assignments")
        return json(fixture.raw.assignments);
      if (path === "/api/v1/planner/items") return json(fixture.raw.upcoming);
      if (path === "/api/v1/users/self/todo") return json(fixture.raw.todo);
      throw new Error("Unexpected fixture endpoint");
    });
    const result = await listQuery(origin, request, fetcher, now);
    expect(result).toEqual({ status: "success", [key]: fixture.expected[key] });
    expect(parseResult(result, request)).toEqual(result);
    for (const [url, options] of fetcher.mock.calls) {
      expect(options).toMatchObject({
        method: "GET",
        credentials: "same-origin",
        redirect: "manual",
        cache: "no-store",
      });
      if (String(url).includes("/assignments"))
        expect(new URL(String(url)).searchParams.get("include[]")).toBe(
          "submission",
        );
    }
    expect(JSON.stringify(result)).not.toMatch(
      /"(?:id|course_id|html_url|assignment|plannable|submission)":/,
    );
  },
);
