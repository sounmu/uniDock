import { afterEach, expect, it, vi } from "vitest";
import { documentCandidate } from "../src/documents";
import { NavigationCatalog } from "../src/navigation-catalog";
import { listQuery } from "../src/api/client";
import { isRequest, parseResult } from "../src/protocol";

const origin = "https://mylms.korea.ac.kr";
const now = Date.parse("2026-09-11T00:00:00Z");
const stores: NavigationCatalog[] = [];
const store = () => {
  const c = new NavigationCatalog();
  stores.push(c);
  return c;
};
const json = (value: unknown, link?: string) =>
  Response.json(value, { headers: link ? { Link: link } : {} });
const pdf = (id: unknown, title: unknown = "slides.PDF") => ({
  id,
  type: "File",
  title,
  url: "https://evil.invalid/signed?token=secret",
  content_id: 99999999,
});
const query = { version: 1, type: "DOCUMENTS_LIST", course: "Course" } as const;
afterEach(() => {
  stores.forEach((c) => c.clear());
  stores.length = 0;
});

it("accepts only accessible PDF File display labels, not arbitrary URLs or unsafe names", () => {
  expect(documentCandidate(pdf(1, "notes.txt"), now)).toBe(false);
  expect(
    documentCandidate(
      {
        ...pdf(1, "notes.txt"),
        content_details: { display_name: "notes.pdf" },
      },
      now,
    ),
  ).toBe(true);
  expect(documentCandidate({ ...pdf(1), type: "ExternalTool" }, now)).toBe(
    false,
  );
  expect(documentCandidate(pdf(1, "https://evil.invalid/file.pdf"), now)).toBe(
    false,
  );
  expect(documentCandidate(pdf(1, "token=secret.pdf"), now)).toBe(false);
  expect(documentCandidate(pdf(1, "x".repeat(2001) + ".pdf"), now)).toBe(false);
  expect(documentCandidate({ ...pdf(1), locked_for_user: true }, now)).toBe(
    false,
  );
  expect(
    documentCandidate(
      { ...pdf(1), content_details: { locked_for_user: true } },
      now,
    ),
  ).toBe(false);
});

it("hydrates truncated lists, keeps module and page order, and exposes only clean handles", async () => {
  const c = store();
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const u = new URL(String(input));
    expect(init).toMatchObject({
      method: "GET",
      credentials: "same-origin",
      redirect: "manual",
      cache: "no-store",
    });
    if (u.pathname === "/api/v1/courses")
      return json([{ id: 101, name: "Course" }]);
    if (u.pathname.endsWith("/modules"))
      return json([
        {
          id: 10,
          name: "Week 1",
          items_count: 2,
          items: [pdf(501, "old.pdf")],
        },
        { id: 20, name: "locked", locked_for_user: true, items_count: 2 },
        {
          id: 30,
          name: "Week 3",
          items: [pdf(503, "last.pdf"), pdf(null), pdf(504, "notes.txt")],
        },
      ]);
    if (u.searchParams.has("page")) return json([pdf(502, "second.pdf")]);
    return json(
      [pdf(501, "first.pdf")],
      `<${origin}${u.pathname}?page=2>; rel="next"`,
    );
  });
  const result = await listQuery(origin, query, fetcher, now, c);
  expect(result.status).toBe("success");
  if (result.status !== "success" || !("documents" in result))
    throw new Error("missing documents");
  expect(
    result.documents.map(({ module, title, type }) => [module, title, type]),
  ).toEqual([
    ["Week 1", "first.pdf", "File"],
    ["Week 1", "second.pdf", "File"],
    ["Week 3", "last.pdf", "File"],
  ]);
  expect(Object.keys(result.documents[0]!)).toEqual([
    "module",
    "title",
    "type",
    "lmsHandle",
    "downloadHandle",
  ]);
  expect(JSON.stringify(result)).not.toMatch(
    /secret|signed|99999999|\/courses\/|content_id/,
  );
  expect(parseResult(result, query)).toEqual(result);
  expect(c.take(result.documents[0]!.lmsHandle, origin, now)).toBe(
    `${origin}/courses/101/modules/items/501`,
  );
  expect(c.take(result.documents[0]!.lmsHandle, origin, now)).toBeNull();
  expect(
    c.take(result.documents[1]!.lmsHandle, origin, now + 300000),
  ).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(4);
});

it("rechecks recorded availability at take and never navigates outside the same-origin item route", () => {
  const c = store();
  const [entry] = c.replaceDocuments(
    origin,
    [
      {
        module: "Week",
        title: "file.pdf",
        courseId: "101",
        itemId: "501",
        moduleAccess: { lock_at: "2026-09-11T00:00:01Z" },
        itemAccess: {},
      },
    ],
    now,
  );
  expect(c.take(entry!.lmsHandle, origin, now + 1000)).toBeNull();
  expect(() =>
    c.replaceDocuments(
      origin,
      [
        {
          module: "X",
          title: "X",
          courseId: "101",
          itemId: "501?token=secret",
          moduleAccess: {},
          itemAccess: {},
        },
      ],
      now,
    ),
  ).toThrow("POLICY");
  expect(c.take(entry!.lmsHandle, origin, now)).toBeNull();
});

it("fails closed on missing hydration ID, malformed pages and pagination escape", async () => {
  for (const mode of ["id", "page", "link"] as const) {
    const c = store();
    const fetcher: typeof fetch = async (input) => {
      const u = new URL(String(input));
      if (u.pathname === "/api/v1/courses")
        return json([{ id: 101, name: "Course" }]);
      if (u.pathname.endsWith("/modules"))
        return json([
          {
            ...(mode === "id" ? {} : { id: 10 }),
            name: "Week",
            items_count: 2,
          },
        ]);
      if (mode === "page")
        return new Response("<html>login</html>", {
          headers: { "Content-Type": "text/html" },
        });
      return json(
        [pdf(501)],
        `<https://evil.invalid/api/v1/courses/101/modules/10/items?page=2>; rel="next"`,
      );
    };
    expect(await listQuery(origin, query, fetcher, now, c)).toEqual({
      status: "error",
      code:
        mode === "id"
          ? "INVALID_RESPONSE"
          : mode === "page"
            ? "LOGIN_REQUIRED"
            : "POLICY",
    });
  }
});

it("enforces a three-worker hydration limit without timing assumptions", async () => {
  const c = store();
  const waiting: (() => void)[] = [];
  let active = 0,
    peak = 0;
  const started: number[] = [];
  const third = Promise.withResolvers<void>();
  const fourth = Promise.withResolvers<void>();
  const fetcher: typeof fetch = async (input) => {
    const u = new URL(String(input));
    if (u.pathname === "/api/v1/courses")
      return json([{ id: 101, name: "Course" }]);
    if (u.pathname.endsWith("/modules"))
      return json(
        [1, 2, 3, 4].map((id) => ({ id, name: `Week ${id}`, items_count: 1 })),
      );
    const id = Number(u.pathname.match(/modules\/(\d+)\/items/)![1]);
    started.push(id);
    peak = Math.max(peak, ++active);
    await new Promise<void>((resolve) => {
      waiting.push(resolve);
      if (id === 3) third.resolve();
      if (id === 4) fourth.resolve();
    });
    active--;
    return json([pdf(id, `${id}.pdf`)]);
  };
  const pending = listQuery(origin, query, fetcher, now, c);
  await third.promise;
  expect(waiting).toHaveLength(3);
  expect(started).toEqual([1, 2, 3]);
  waiting.shift()!();
  await fourth.promise;
  expect(waiting).toHaveLength(3);
  expect(started).toEqual([1, 2, 3, 4]);
  waiting.splice(0).forEach((resolve) => resolve());
  const result = await pending;
  expect(peak).toBe(3);
  if (result.status !== "success" || !("documents" in result))
    throw new Error("missing documents");
  expect(result.documents.map((d) => d.title)).toEqual([
    "1.pdf",
    "2.pdf",
    "3.pdf",
    "4.pdf",
  ]);
});

it("validates closed requests and strips untrusted response fields", () => {
  const handle = crypto.randomUUID();
  expect(isRequest(query)).toBe(true);
  expect(isRequest({ version: 1, type: "DOCUMENT_OPEN", handle })).toBe(true);
  expect(
    isRequest({ version: 1, type: "DOCUMENT_OPEN", handle, url: origin }),
  ).toBe(false);
  expect(
    parseResult(
      {
        status: "success",
        documents: [
          {
            module: "X",
            title: "file.pdf",
            type: "File",
            lmsHandle: handle,
            downloadHandle: "",
            url: "secret",
            id: 501,
          },
        ],
      },
      query,
    ),
  ).toEqual({
    status: "success",
    documents: [
      {
        module: "X",
        title: "file.pdf",
        type: "File",
        lmsHandle: handle,
        downloadHandle: "",
      },
    ],
  });
  expect(
    parseResult(
      {
        status: "success",
        documents: [
          {
            module: "X",
            title: "file.pdf",
            type: "ExternalTool",
            lmsHandle: handle,
          },
        ],
      },
      query,
    ),
  ).toEqual({ status: "error", code: "INVALID_RESPONSE" });
  expect(
    parseResult(
      { status: "success", opened: true },
      { version: 1, type: "DOCUMENT_OPEN", handle },
    ),
  ).toEqual({ status: "success", opened: true });
});
