import { describe, expect, it, vi } from "vitest";
import fixture from "./fixtures/courses.json";
import { listCourses } from "../src/api/client";
import { nextPage } from "../src/api/pagination";
import { projectCourses } from "../src/domain";
import { isRequest, parseResult, request } from "../src/protocol";
import { allowedPage, courseUrl } from "../src/security/policy";
import { redactText } from "../src/security/redaction";
import { safeLog } from "../src/security/logger";
const origin = "https://mylms.korea.ac.kr";
const json = (body: unknown, headers = {}) =>
  new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json", ...headers },
  });
describe("privacy and policy", () => {
  it("projects only names", () =>
    expect(projectCourses(fixture)).toEqual([
      { name: "국제법" },
      { name: "운영체제" },
    ]));
  it("redacts identifiers and URLs embedded in names", () => {
    expect(
      projectCourses([
        { id: 101, name: "과목 101 https://example.invalid/lti?token=secret" },
      ]),
    ).toEqual([{ name: "과목 [REDACTED] [REDACTED]" }]);
    expect(redactText("a@example.invalid token=private")).not.toContain(
      "private",
    );
  });
  it.each([
    "http://mylms.korea.ac.kr/",
    "https://mylms.korea.ac.kr.evil.invalid/",
    "https://u:p@mylms.korea.ac.kr/",
    "https://mylms.korea.ac.kr:444/",
  ])("rejects host %s", (url) => expect(allowedPage(url)).toBe(false));
  it.each([
    "/api/v1/courses/1",
    "/api/v1/courses?access_token=secret",
    "/api/v1/courses?per_page=999",
    "/api/v1/courses?page=1&page=2",
    "/api/v1/courses?enrollment_state=deleted",
    "https://canvas.korea.ac.kr/api/v1/courses",
    "/api/v1/courses#secret",
  ])("rejects endpoint %s", (url) =>
    expect(() => courseUrl(url, origin)).toThrow(),
  );
  it("accepts only exact read request", () => {
    expect(isRequest(request)).toBe(true);
    for (const value of [
      null,
      { type: "submit", version: 1 },
      { ...request, url: origin },
      { ...request, method: "POST" },
    ])
      expect(isRequest(value)).toBe(false);
  });
  it("re-projects protocol responses", () => {
    expect(
      parseResult({ status: "success", courses: fixture, token: "secret" }),
    ).toEqual({
      status: "success",
      courses: [{ name: "국제법" }, { name: "운영체제" }],
    });
    expect(parseResult({ status: "error", code: "secret" })).toEqual({
      status: "error",
      code: "INVALID_RESPONSE",
    });
  });
  it("logger accepts no arbitrary payload even at runtime", () => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    safeLog("REQUEST_FAILED");
    safeLog("secret" as "REQUEST_FAILED");
    expect(log.mock.calls).toEqual([["[uniDock] REQUEST_FAILED"]]);
    log.mockRestore();
  });
});
describe("session API and pagination", () => {
  it("uses GET with same-origin credentials and projects every page", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json(fixture, {
          Link: `<${origin}/api/v1/courses?page=2>; rel="next"`,
        }),
      )
      .mockResolvedValueOnce(json([{ id: 404, name: "자료구조" }]));
    expect(await listCourses(origin, fetcher)).toEqual({
      status: "success",
      courses: [{ name: "국제법" }, { name: "운영체제" }, { name: "자료구조" }],
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      method: "GET",
      credentials: "same-origin",
      redirect: "manual",
      cache: "no-store",
    });
  });
  it("supports empty list", async () =>
    expect(
      await listCourses(origin, vi.fn().mockResolvedValue(json([]))),
    ).toEqual({ status: "success", courses: [] }));
  it.each([
    [401, "LOGIN_REQUIRED"],
    [403, "FORBIDDEN"],
    [302, "LOGIN_REQUIRED"],
    [500, "NETWORK"],
  ])("maps HTTP %s safely", async (status, code) => {
    expect(
      await listCourses(
        origin,
        vi
          .fn()
          .mockResolvedValue(
            new Response("private", { status: Number(status) }),
          ),
      ),
    ).toEqual({ status: "error", code });
  });
  it("detects login HTML", async () =>
    expect(
      await listCourses(
        origin,
        vi.fn().mockResolvedValue(
          new Response("<html>secret</html>", {
            headers: { "Content-Type": "text/html" },
          }),
        ),
      ),
    ).toEqual({ status: "error", code: "LOGIN_REQUIRED" }));
  it("detects opaque redirects", async () =>
    expect(
      await listCourses(
        origin,
        vi.fn().mockResolvedValue({ type: "opaqueredirect" }),
      ),
    ).toEqual({ status: "error", code: "LOGIN_REQUIRED" }));
  it("rejects malformed response shape", async () =>
    expect(
      await listCourses(
        origin,
        vi.fn().mockResolvedValue(json({ token: "secret" })),
      ),
    ).toEqual({ status: "error", code: "INVALID_RESPONSE" }));
  it("does not fetch hostile next links", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      json(fixture, {
        Link: '<https://evil.invalid/api/v1/courses?page=2>; rel="next"',
      }),
    );
    expect(await listCourses(origin, fetcher)).toEqual({
      status: "error",
      code: "POLICY",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("fails closed on loops without returning partial data", async () => {
    const fetcher = vi.fn().mockImplementation(async () =>
      json(fixture, {
        Link: `<${origin}/api/v1/courses?page=2>; rel="next"`,
      }),
    );
    expect(await listCourses(origin, fetcher)).toEqual({
      status: "error",
      code: "LIMIT",
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("bounds total request time", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>(
      (_url, options) =>
        new Promise((_resolve, reject) =>
          options?.signal?.addEventListener("abort", () =>
            reject(new Error("secret")),
          ),
        ),
    );
    const pending = listCourses(origin, fetcher);
    await vi.advanceTimersByTimeAsync(20000);
    expect(await pending).toEqual({ status: "error", code: "TIMEOUT" });
    vi.useRealTimers();
  });
  it("drops network exception details", async () =>
    expect(
      await listCourses(
        origin,
        vi.fn().mockRejectedValue(new Error("cookie=secret")),
      ),
    ).toEqual({ status: "error", code: "NETWORK" }));
  it("parses relation lists and rejects ambiguous links", () => {
    expect(
      nextPage(`<${origin}/api/v1/courses?page=2>; rel="next last"`, origin),
    ).toContain("page=2");
    expect(() => nextPage("malformed", origin)).toThrow();
    expect(() =>
      nextPage(
        `<${origin}/api/v1/courses?page=2>; rel="next", <${origin}/api/v1/courses?page=3>; rel="next"`,
        origin,
      ),
    ).toThrow();
  });
});
