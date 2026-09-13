import { expect, it, vi } from "vitest";
import { listQuery } from "../src/api/client";
import { readUrl } from "../src/security/policy";
import { isRequest, parseResult, type Request } from "../src/protocol";
import {
  projectAssignments,
  projectUpcoming,
  projectTodo,
  isoTime,
} from "../src/domain-items";
const origin = "https://mylms.korea.ac.kr";
const json = (body: unknown, link?: string) =>
  new Response(JSON.stringify(body), {
    headers: {
      "Content-Type": "application/json",
      ...(link ? { Link: link } : {}),
    },
  });
it.each([
  "ASSIGNMENTS_LIST",
  "DEADLINES_LIST",
  "UPCOMING_LIST",
  "TODO_LIST",
] as const)("paginates %s", async (type) => {
  const assignment = type === "ASSIGNMENTS_LIST" || type === "DEADLINES_LIST";
  const path = assignment
    ? "/api/v1/courses/101/assignments"
    : type === "UPCOMING_LIST"
      ? "/api/v1/planner/items"
      : "/api/v1/users/self/todo";
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/v1/courses")
      return json([{ id: 101, name: "과목" }]);
    expect(url.pathname).toBe(path);
    const body = assignment
      ? { name: "과제" }
      : type === "UPCOMING_LIST"
        ? { plannable: { title: "예정" } }
        : { assignment: { name: "할 일" } };
    return json(
      [body],
      url.searchParams.has("page")
        ? undefined
        : `<${origin}${path}?page=2>; rel="next"`,
    );
  });
  const request: Request = assignment
    ? { version: 1, type, course: "과목" }
    : { version: 1, type };
  const result = await listQuery(origin, request, fetcher);
  expect(result.status).toBe("success");
  const arrays = Object.values(result).filter(Array.isArray);
  expect(arrays[0]).toHaveLength(2);
  expect(fetcher).toHaveBeenCalledTimes(assignment ? 3 : 2);
});
it.each([
  [{ version: 1, type: "ASSIGNMENTS_LIST", course: "" }],
  [{ version: 1, type: "ASSIGNMENTS_LIST", course: "x", course_id: 101 }],
  [{ version: 1, type: "TODO_LIST", method: "DELETE" }],
  [{ version: 1, type: "UPCOMING_LIST", start_date: "2026-02-30" }],
  [
    {
      version: 1,
      type: "UPCOMING_LIST",
      start_date: "2026-10-01",
      end_date: "2026-09-01",
    },
  ],
  [{ version: 1, type: "UPCOMING_LIST", url: "https://example.invalid/" }],
])("rejects malformed request %j", (value) =>
  expect(isRequest(value)).toBe(false),
);
it("validates at runtime before making any fetch", async () => {
  const fetcher = vi.fn();
  expect(
    await listQuery(
      origin,
      { version: 1, type: "TODO_LIST", method: "POST" } as Request,
      fetcher,
    ),
  ).toEqual({ status: "error", code: "POLICY" });
  expect(fetcher).not.toHaveBeenCalled();
});
it("sends validated upcoming dates", async () => {
  const fetcher = vi.fn().mockResolvedValue(json([]));
  expect(
    await listQuery(
      origin,
      {
        version: 1,
        type: "UPCOMING_LIST",
        start_date: "2026-09-01",
        end_date: "2026-09-30",
      },
      fetcher,
    ),
  ).toEqual({ status: "success", upcoming: [] });
  const url = new URL(fetcher.mock.calls[0]![0]);
  expect(url.searchParams.get("start_date")).toBe("2026-09-01");
  expect(url.searchParams.get("end_date")).toBe("2026-09-30");
});
it.each([
  "?include[]=submission_comments",
  "/1/submissions",
  "?access_token=private",
  "?include[]=submission&include[]=submission",
  "?start_date=2026-09-01",
])("blocks assignment URL suffix %s", (suffix) => {
  expect(() =>
    readUrl(
      `/api/v1/courses/101/assignments${suffix}`,
      origin,
      "/api/v1/courses/101/assignments",
    ),
  ).toThrow("POLICY");
});
it("never follows another course or endpoint from Link", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(json([{ id: 101, name: "과목" }]))
    .mockResolvedValueOnce(
      json([], `<${origin}/api/v1/courses/202/assignments?page=2>; rel="next"`),
    );
  expect(
    await listQuery(
      origin,
      { version: 1, type: "ASSIGNMENTS_LIST", course: "과목" },
      fetcher,
    ),
  ).toEqual({ status: "error", code: "POLICY" });
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it.each([
  ["없음", "COURSE_NOT_FOUND"],
  ["법", "COURSE_AMBIGUOUS"],
])("reports course selection error safely: %s", async (course, code) => {
  const fetcher = vi.fn().mockResolvedValue(
    json([
      { id: 101, name: "국제법" },
      { id: 202, name: "국제법연습" },
    ]),
  );
  expect(
    await listQuery(
      origin,
      { version: 1, type: "ASSIGNMENTS_LIST", course: course! },
      fetcher,
    ),
  ).toEqual({ status: "error", code });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("selects course on a later page and prefers the exact name", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      json(
        [{ id: 303, name: "국제법연습" }],
        `<${origin}/api/v1/courses?page=2>; rel="next"`,
      ),
    )
    .mockResolvedValueOnce(json([{ id: 101, name: "국제법" }]))
    .mockResolvedValueOnce(json([]));
  expect(
    await listQuery(
      origin,
      { version: 1, type: "ASSIGNMENTS_LIST", course: " 국제법 " },
      fetcher,
    ),
  ).toEqual({ status: "success", assignments: [] });
  expect(String(fetcher.mock.calls[2]![0])).toContain(
    "/courses/101/assignments",
  );
});
it("rejects identical course names instead of selecting arbitrary ID", async () => {
  const fetcher = vi.fn().mockResolvedValue(
    json([
      { id: 101, name: "과목" },
      { id: 202, name: "과목" },
    ]),
  );
  expect(
    await listQuery(
      origin,
      { version: 1, type: "DEADLINES_LIST", course: "과목" },
      fetcher,
    ),
  ).toEqual({ status: "error", code: "COURSE_AMBIGUOUS" });
});
it("does not return partial assignments on session expiry", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(json([{ id: 101, name: "과목" }]))
    .mockResolvedValueOnce(
      json(
        [{ name: "과제" }],
        `<${origin}/api/v1/courses/101/assignments?page=2>; rel="next"`,
      ),
    )
    .mockResolvedValueOnce(new Response("", { status: 401 }));
  expect(
    await listQuery(
      origin,
      { version: 1, type: "ASSIGNMENTS_LIST", course: "과목" },
      fetcher,
    ),
  ).toEqual({ status: "error", code: "LOGIN_REQUIRED" });
});
it("removes raw metadata and redacts text in all projections", () => {
  const raw = {
    id: 777,
    course_id: 888,
    name: "과제 777 https://example.invalid/private",
    context_name: "과목 888",
    html_url: "private",
    description: "private",
    token: "private",
    plannable: { id: 777, title: "과제 777" },
    assignment: { id: 777, name: "과제 777" },
  };
  for (const result of [
    projectAssignments([raw]),
    projectUpcoming([raw]),
    projectTodo([raw]),
  ])
    expect(JSON.stringify(result)).not.toMatch(
      /777|888|private|html_url|token|description/,
    );
});
it("rejects wrong response type and invalid public fields", () => {
  expect(
    parseResult(
      { status: "success", todo: [] },
      { version: 1, type: "UPCOMING_LIST" },
    ),
  ).toEqual({ status: "error", code: "INVALID_RESPONSE" });
  expect(
    parseResult({
      status: "success",
      upcoming: [{ title: { token: "private" } }],
    }),
  ).toEqual({ status: "error", code: "INVALID_RESPONSE" });
});
it("accepts Canvas Todo ignore action URLs without exposing them", async () => {
  const ignoreUrl = `${origin}/api/v1/users/self/todo/assignment_123/ignore`;
  const fetcher = vi.fn().mockResolvedValue(
    json([
      {
        type: "submitting",
        context_name: "국제법",
        assignment: {
          name: "퀴즈9차",
          due_at: "2026-09-20T09:00:00Z",
        },
        ignore: ignoreUrl,
      },
    ]),
  );

  const result = await listQuery(
    origin,
    { version: 1, type: "TODO_LIST" },
    fetcher,
  );

  expect(result).toEqual({
    status: "success",
    todo: [
      {
        title: "퀴즈9차",
        due_at: "2026-09-20T09:00:00Z",
        type: "submitting",
        course: "국제법",
        ignore: true,
      },
    ],
  });
  expect(JSON.stringify(result)).not.toContain(ignoreUrl);
});
it("uses UTC for naive datetime and rejects rollover dates", () => {
  expect(isoTime("2026-09-11T00:00:00")).toBe(
    Date.parse("2026-09-11T00:00:00Z"),
  );
  expect(Number.isNaN(isoTime("2099-02-30T00:00:00Z"))).toBe(true);
});

const invalidBooleanValues = ["true", 1, [], {}] as const;
const invalidBooleanProjections: readonly {
  readonly field: string;
  readonly project: (value: unknown) => void;
}[] = [
  {
    field: "assignment published",
    project: (value) =>
      projectAssignments([{ name: "과제", published: value }]),
  },
  {
    field: "assignment locked_for_user",
    project: (value) =>
      projectAssignments([{ name: "과제", locked_for_user: value }]),
  },
  {
    field: "assignment submission missing",
    project: (value) =>
      projectAssignments([{ name: "과제", submission: { missing: value } }]),
  },
  {
    field: "assignment submission late",
    project: (value) =>
      projectAssignments([{ name: "과제", submission: { late: value } }]),
  },
  {
    field: "upcoming submitted",
    project: (value) =>
      projectUpcoming([
        { plannable: { title: "예정" }, submissions: { submitted: value } },
      ]),
  },
  {
    field: "upcoming new_activity",
    project: (value) =>
      projectUpcoming([{ plannable: { title: "예정" }, new_activity: value }]),
  },
];

it.each(invalidBooleanProjections)(
  "rejects malformed $field booleans",
  ({ project }) => {
    for (const value of invalidBooleanValues)
      expect(() => project(value)).toThrow("INVALID_RESPONSE");
  },
);

it.each([1, [], {}])("rejects malformed Canvas Todo ignore value %j", (value) =>
  expect(() =>
    projectTodo([{ assignment: { name: "할 일" }, ignore: value }]),
  ).toThrow("INVALID_RESPONSE"),
);

it("preserves assignment boolean defaults and real values", () => {
  const [realValues] = projectAssignments([
    {
      name: "과제",
      published: true,
      locked_for_user: true,
      submission: { missing: false, late: true },
    },
  ]);
  const [missingPublished] = projectAssignments([{ name: "과제" }]);
  const [nullPublished] = projectAssignments([
    { name: "과제", published: null },
  ]);

  expect(realValues).toMatchObject({
    published: true,
    locked_for_user: true,
    missing: false,
    late: true,
  });
  expect(missingPublished?.published).toBe(true);
  expect(nullPublished?.published).toBe(false);
});

it("uses submitted_at when an upcoming item has no submitted boolean", () => {
  const [upcoming] = projectUpcoming([
    {
      plannable: { title: "예정" },
      submissions: { submitted_at: "2026-09-11T00:00:00Z" },
      new_activity: false,
    },
  ]);

  expect(upcoming).toMatchObject({ submitted: true, new_activity: false });
});
