import { expect, it } from "vitest";
import { documentCandidate, documentMimeMatches } from "../src/documents";
import { safeDownloadPath, validDownloadPath } from "../src/security/download";
import { listQuery } from "../src/api/client";
import { NavigationCatalog } from "../src/navigation-catalog";
import { parseResult } from "../src/protocol";

const origin = "https://mylms.korea.ac.kr";
const query = { version: 1, type: "DOCUMENTS_LIST", course: "Course" } as const;

it("preserves presentation extensions, including long filenames, and checks MIME by format", () => {
  for (const extension of ["pdf", "ppt", "pptx"]) {
    expect(
      documentCandidate({
        type: "File",
        title: `자료.${extension.toUpperCase()}`,
      }),
    ).toBe(true);
    const path = safeDownloadPath(
      "Course",
      "Week",
      `${"a".repeat(150)}.${extension}`,
    )!;
    expect(path.endsWith(`.${extension}`)).toBe(true);
    expect(validDownloadPath(path)).toBe(true);
  }
  expect(documentCandidate({ type: "File", title: "file.pptm" })).toBe(false);
  expect(
    safeDownloadPath("Course", "Week", `${"a".repeat(76)}.pdf-long.pptx`),
  ).toMatch(/\.pptx$/);
  expect(validDownloadPath("uniDock/a/b/file.exe")).toBe(false);
  expect(documentMimeMatches("file.ppt", "application/vnd.ms-powerpoint")).toBe(
    true,
  );
  expect(
    documentMimeMatches(
      "file.pptx",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ),
  ).toBe(true);
  expect(documentMimeMatches("file.pptx", "application/pdf")).toBe(false);
  expect(documentMimeMatches("file.pdf", "text/html")).toBe(false);
});

it("collects weekly files and paginated board/announcement attachments without exposing IDs or signed URLs", async () => {
  const catalog = new NavigationCatalog();
  const attachment = {
    id: 9,
    display_name: "발표.pptx",
    url: "https://evil.invalid/?token=secret",
  };
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
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
              title: "강의자료",
              content_id: 4,
              content_details: { display_name: "교안.ppt" },
            },
          ],
        },
      ]);
    if (url.searchParams.has("only_announcements"))
      return Response.json([
        { id: 8, title: "공지", attachment: { id: 10, filename: "안내.pdf" } },
      ]);
    if (url.searchParams.has("page"))
      return Response.json([
        { id: 7, title: "숨김", locked_for_user: true, attachment },
      ]);
    return Response.json(
      [
        {
          id: 6,
          title: "수업 게시판",
          attachment,
          attachments: [
            attachment,
            { id: 11, filename: "숨김.pdf", hidden: true },
          ],
        },
      ],
      { headers: { Link: `<${origin}${url.pathname}?page=2>; rel="next"` } },
    );
  };
  try {
    const result = await listQuery(origin, query, fetcher, Date.now(), catalog);
    if (result.status !== "success" || !("documents" in result))
      throw new Error("missing documents");
    expect(
      result.documents.map(({ title, filename }) => [title, filename]),
    ).toEqual([
      ["강의자료", "교안.ppt"],
      ["발표.pptx", "발표.pptx"],
      ["안내.pdf", "안내.pdf"],
    ]);
    // The instructor title is for display; the saved file keeps its real name.
    expect(
      catalog.takeDownload(result.documents[0]!.downloadHandle, origin)?.title,
    ).toBe("교안.ppt");
    expect(parseResult(result, query)).toEqual(result);
    expect(JSON.stringify(result)).not.toMatch(
      /evil|secret|content_id|\/courses\//,
    );
    expect(catalog.take(result.documents[1]!.lmsHandle, origin)).toBe(
      `${origin}/courses/1/discussion_topics/6`,
    );
    expect(
      catalog.takeDownload(result.documents[1]!.downloadHandle, origin)?.url,
    ).toBe(`${origin}/courses/1/files/9/download?download_frd=1`);
    expect(
      catalog.takeDownload(result.documents[1]!.downloadHandle, origin),
    ).toBeNull();
  } finally {
    catalog.clear();
  }
});

it("publishes no partial weekly results when board pagination fails", async () => {
  const catalog = new NavigationCatalog();
  const publish = catalog.replaceDocuments.bind(catalog);
  let published = false;
  catalog.replaceDocuments = (...args) => {
    published = true;
    return publish(...args);
  };
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/v1/courses")
      return Response.json([{ id: 1, name: "Course" }]);
    if (url.pathname.endsWith("/modules"))
      return Response.json([
        {
          id: 2,
          name: "Week",
          items: [{ id: 3, type: "File", title: "notes.pdf" }],
        },
      ]);
    return Response.json([], {
      headers: {
        Link: '<https://evil.invalid/api/v1/courses/1/discussion_topics?page=2>; rel="next"',
      },
    });
  };
  expect(await listQuery(origin, query, fetcher, Date.now(), catalog)).toEqual({
    status: "error",
    code: "POLICY",
  });
  expect(published).toBe(false);
  catalog.clear();
});

function weeklyFetcher(
  topics: (url: URL) => Response | Promise<Response>,
): typeof fetch {
  return async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/v1/courses")
      return Response.json([{ id: 1, name: "Course" }]);
    if (url.pathname.endsWith("/modules"))
      return Response.json([
        {
          id: 2,
          name: "Week",
          items: [{ id: 3, type: "File", title: "notes.pdf", content_id: 4 }],
        },
      ]);
    return topics(url);
  };
}

it("keeps weekly materials when the LMS refuses the board or announcement source", async () => {
  for (const [boards, announcements] of [
    [401, 404],
    [403, 200],
    [200, 401],
  ]) {
    const catalog = new NavigationCatalog();
    const fetcher = weeklyFetcher((url) => {
      const status = url.searchParams.has("only_announcements")
        ? announcements
        : boards;
      return status === 200
        ? Response.json([])
        : Response.json({ errors: [{ message: "unauthorized" }] }, { status });
    });
    const result = await listQuery(origin, query, fetcher, Date.now(), catalog);
    expect(result).toMatchObject({
      status: "success",
      documents: [{ title: "notes.pdf" }],
    });
    catalog.clear();
  }
});

it("still fails the whole list when an optional source fails after its first page or redirects", async () => {
  const later = new NavigationCatalog();
  expect(
    await listQuery(
      origin,
      query,
      weeklyFetcher((url) =>
        url.searchParams.has("page")
          ? new Response(null, { status: 401 })
          : Response.json([], {
              headers: {
                Link: `<${origin}${url.pathname}?page=2>; rel="next"`,
              },
            }),
      ),
      Date.now(),
      later,
    ),
  ).toEqual({ status: "error", code: "LOGIN_REQUIRED" });
  expect(later.size()).toBe(0);
  const redirect = new NavigationCatalog();
  expect(
    await listQuery(
      origin,
      query,
      weeklyFetcher(
        () =>
          new Response(null, {
            status: 302,
            headers: { Location: `${origin}/login` },
          }),
      ),
      Date.now(),
      redirect,
    ),
  ).toEqual({ status: "error", code: "LOGIN_REQUIRED" });
  expect(redirect.size()).toBe(0);
});
