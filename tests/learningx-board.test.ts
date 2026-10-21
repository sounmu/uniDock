import { expect, it, vi } from "vitest";
import { listQuery } from "../src/api/client";
import { NavigationCatalog } from "../src/navigation-catalog";
import { parseResult } from "../src/protocol";
import { learningxToken } from "../src/security/learningx-token";
import { readUrl } from "../src/security/policy";
import { navigationUrl } from "../src/security/navigation";

const origin = "https://mylms.korea.ac.kr";
const query = { version: 1, type: "DOCUMENTS_LIST", course: "Course" } as const;
const token = "aaa.bbb.ccc";
const root = "/learningx/api/v1/learningx_board/courses/1/boards";

it("reads only a single JWT-shaped LearningX token cookie", () => {
  expect(learningxToken(`a=1; xn_api_token=${token}; b=2`)).toBe(token);
  expect(learningxToken("a=1")).toBeNull();
  expect(learningxToken("xn_api_token=not-a-jwt")).toBeNull();
  expect(learningxToken(`xn_api_token=${token}; xn_api_token=${token}`)).toBe(
    null,
  );
  expect(learningxToken(`xn_api_token=${"a".repeat(4097)}.b.c`)).toBeNull();
  expect(learningxToken(undefined)).toBeNull();
});

it("allows only the fixed LearningX board read paths and the post page key", () => {
  expect(readUrl(root, origin, root).pathname).toBe(root);
  expect(
    readUrl(`${root}/2/posts?page=3`, origin, `${root}/2/posts`).search,
  ).toBe("?page=3");
  expect(readUrl(`${root}/2/posts/4`, origin, `${root}/2/posts/4`).href).toBe(
    `${origin}${root}/2/posts/4`,
  );
  for (const [value, path] of [
    [`${root}?page=1`, root],
    [`${root}/2/posts?per_page=100`, `${root}/2/posts`],
    [`${root}/2/posts?keyword=x`, `${root}/2/posts`],
    [`${root}/2/posts/4?page=1`, `${root}/2/posts/4`],
    [`${root}/2/posts/4/comments`, `${root}/2/posts/4/comments`],
    [`${root}/2/download_attachments`, `${root}/2/download_attachments`],
    [
      `/learningx/api/v1/learningx_total_board/posts`,
      "/learningx/api/v1/learningx_total_board/posts",
    ],
  ] as const)
    expect(() => readUrl(value, origin, path)).toThrow("POLICY");
  expect(navigationUrl(`${origin}/courses/1/external_tools/5`, origin)).toBe(
    `${origin}/courses/1/external_tools/5`,
  );
  expect(
    navigationUrl(`${origin}/courses/1/external_tools/5?post_id=1`, origin),
  ).toBeNull();
});

function lms(
  board: (url: URL, init?: RequestInit) => Response | undefined,
): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.startsWith("/learningx/")) {
      const response = board(url, init);
      if (response) return response;
      throw new Error(`unexpected ${url.pathname}`);
    }
    expect(new Headers(init?.headers).has("Authorization")).toBe(false);
    if (url.pathname === "/api/v1/courses")
      return Response.json([{ id: 1, name: "Course" }]);
    if (url.pathname.endsWith("/modules"))
      return Response.json([
        {
          id: 2,
          name: "1주차",
          items: [
            {
              id: 3,
              type: "File",
              title: "교안",
              content_id: 40,
              content_details: { display_name: "교안.pdf" },
            },
          ],
        },
      ]);
    if (url.pathname.endsWith("/discussion_topics")) return Response.json([]);
    throw new Error(`unexpected ${url.pathname}`);
  });
}

it("lists LearningX board attachments after weekly files with clean handles", async () => {
  const catalog = new NavigationCatalog();
  const now = Date.parse("2026-10-04T00:00:00Z");
  const fetcher = lms((url, init) => {
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      `Bearer ${token}`,
    );
    expect(init).toMatchObject({ method: "GET", redirect: "manual" });
    if (url.pathname === root)
      return Response.json([
        { id: 7, type: "qna", title: "Q&A" },
        { id: 8, type: "normal", title: "강의자료실" },
      ]);
    if (url.pathname === `${root}/7/posts`)
      return Response.json({
        items: [],
        pagination: { current_page: 1, last_page: 1 },
      });
    if (url.pathname === `${root}/8/posts`) {
      const page = url.searchParams.get("page");
      return Response.json({
        items:
          page === "1"
            ? [
                { id: 21, title: "2. Image Formation", attachment_count: 2 },
                { id: 22, title: "공지", attachment_count: 0 },
              ]
            : [
                { id: 23, title: "1. Introduction", attachment_count: 1 },
                {
                  id: 24,
                  title: "예약",
                  attachment_count: 1,
                  reserved_at: "2026-12-01T00:00:00Z",
                },
              ],
        pagination: { current_page: Number(page), last_page: 2 },
      });
    }
    const detail = (id: number, title: string, attachments: unknown[]) =>
      Response.json({
        id,
        title,
        post_url: `${origin}/learningx/redirect/courses/1/external_tools/5?post_id=${id}&target=x`,
        attachments,
      });
    if (url.pathname === `${root}/8/posts/21`)
      return detail(21, "2. Image Formation", [
        {
          id: 1,
          canvas_file_id: 50,
          filename: "2. Image Formation.pdf",
          url: `${origin}/files/50/download?verifier=secret`,
        },
        { id: 2, canvas_file_id: 51, filename: "code.zip" },
        // Already listed from the weekly module.
        { id: 3, canvas_file_id: 40, filename: "교안.pdf" },
      ]);
    if (url.pathname === `${root}/8/posts/23`)
      return detail(23, "1. Introduction", [
        { id: 4, canvas_file_id: 52, filename: "1. Introduction.pptx" },
      ]);
    return undefined;
  });
  try {
    const result = await listQuery(
      origin,
      query,
      fetcher,
      now,
      catalog,
      undefined,
      () => token,
    );
    if (result.status !== "success" || !("documents" in result))
      throw new Error("missing documents");
    expect(
      result.documents.map(({ module, title }) => [module, title]),
    ).toEqual([
      ["1주차", "교안"],
      ["게시판 · 2. Image Formation", "2. Image Formation.pdf"],
      ["게시판 · 1. Introduction", "1. Introduction.pptx"],
    ]);
    expect(parseResult(result, query)).toEqual(result);
    expect(JSON.stringify(result)).not.toMatch(
      /aaa\.bbb|secret|verifier|external_tools|\/courses\//,
    );
    expect(catalog.take(result.documents[1]!.lmsHandle, origin, now)).toBe(
      `${origin}/courses/1/external_tools/5`,
    );
    expect(
      catalog.takeDownload(result.documents[2]!.downloadHandle, origin, now)
        ?.url,
    ).toBe(`${origin}/courses/1/files/52/download?download_frd=1`);
    expect(
      fetcher.mock.calls.some(([input]) =>
        String(input).includes(`${root}/8/posts/24`),
      ),
    ).toBe(false);
  } finally {
    catalog.clear();
  }
});

it("skips boards without a token or when LearningX refuses the board list", async () => {
  for (const [read, status] of [
    [() => null, 0],
    [() => token, 401],
    [() => token, 404],
  ] as const) {
    const catalog = new NavigationCatalog();
    const fetcher = lms((url) =>
      url.pathname === root ? new Response(null, { status }) : undefined,
    );
    try {
      const result = await listQuery(
        origin,
        query,
        fetcher,
        Date.now(),
        catalog,
        undefined,
        read,
      );
      expect(
        result.status === "success" && "documents" in result
          ? result.documents.map(({ title }) => title)
          : result,
      ).toEqual(["교안"]);
      expect(
        fetcher.mock.calls.filter(([input]) =>
          String(input).includes("/learningx/"),
        ),
      ).toHaveLength(status ? 1 : 0);
    } finally {
      catalog.clear();
    }
  }
});

it("fails the whole list, without a login reset, when a later board request fails", async () => {
  const catalog = new NavigationCatalog();
  const publish = vi.spyOn(catalog, "replaceDocuments");
  const fetcher = lms((url) => {
    if (url.pathname === root) return Response.json([{ id: 8 }]);
    if (url.pathname === `${root}/8/posts`)
      return Response.json({
        items: [{ id: 21, title: "자료", attachment_count: 1 }],
        pagination: { last_page: 1 },
      });
    if (url.pathname === `${root}/8/posts/21`)
      return new Response(null, { status: 401 });
    return undefined;
  });
  const result = await listQuery(
    origin,
    query,
    fetcher,
    Date.now(),
    catalog,
    undefined,
    () => token,
  );
  expect(result).toEqual({ status: "error", code: "NETWORK" });
  expect(publish).not.toHaveBeenCalled();
});

it("rejects unbounded or malformed board pagination", async () => {
  for (const last_page of [101, 0, "2", 1.5]) {
    const catalog = new NavigationCatalog();
    const fetcher = lms((url) => {
      if (url.pathname === root) return Response.json([{ id: 8 }]);
      if (url.pathname === `${root}/8/posts`)
        return Response.json({ items: [], pagination: { last_page } });
      return undefined;
    });
    expect(
      await listQuery(
        origin,
        query,
        fetcher,
        Date.now(),
        catalog,
        undefined,
        () => token,
      ),
    ).toEqual({ status: "error", code: "INVALID_RESPONSE" });
  }
});
