import { expect, it } from "vitest";
import {
  lmsFileDownloadUrl,
  safeDownloadPath,
  validDownloadPath,
} from "../src/security/download";
import { isRequest, parseResult } from "../src/protocol";
const origin = "https://mylms.korea.ac.kr";
const path = "/courses/101/files/501/download";
const url = `${origin}${path}?download_frd=1`;

it.each([origin, "https://canvas.korea.ac.kr"])(
  "accepts the canonical file route when source is %s",
  (source) => {
    // Given
    const value = `${source}${path}?download_frd=1`;
    // When / Then
    expect(lmsFileDownloadUrl(value, `${source}/courses/101`)).toBe(value);
  },
);
it.each([
  null,
  42,
  "https://evil.invalid" + path + "?download_frd=1",
  "https://canvas.korea.ac.kr" + path + "?download_frd=1",
  `${origin}${path}/x?download_frd=1`,
  `${origin}${path}`,
  `${url}&extra=1`,
  `${url}&download_frd=1`,
  `${origin}${path}?download_frd=2`,
  `${origin}${path}?%64ownload_frd=1`,
  `${url}#fragment`,
  `${url}#`,
  url.replace("https://", "https://user:password@"),
  `${url}&${"x".repeat(301)}`,
  `${origin}/courses/0/files/501/download?download_frd=1`,
  `${origin}/courses/01/files/501/download?download_frd=1`,
  `${origin}/courses/101/files/501/../501/download?download_frd=1`,
  `${origin}/courses/101/files/501%2fdownload?download_frd=1`,
  url.replace("https://", "http://"),
  `${url}\n`,
])("rejects a noncanonical or hostile download value %j", (value) => {
  // Given / When / Then
  expect(lmsFileDownloadUrl(value, origin)).toBeNull();
});
it("rejects cross-LMS and unapproved source documents", () => {
  // Given / When / Then
  expect(lmsFileDownloadUrl(url, "https://canvas.korea.ac.kr/")).toBeNull();
  expect(lmsFileDownloadUrl(url, "https://evil.invalid/")).toBeNull();
});
it.each([
  ["Course", "Week", "slides", "uniDock/Course/Week/slides.pdf"],
  ["..", ".", "", "uniDock/_/_/_.pdf"],
  ["/abs", "C:\\", 'a/b\\c:*?"<>|.pdf', "uniDock/_abs/C__/a_b_c_______.pdf"],
  [" \u0000 ", "Week\nName", "slides.PDF", "uniDock/_/Week Name/slides.PDF"],
  [". Course .", "Week", "file.pdf", "uniDock/Course/Week/file.pdf"],
])(
  "normalizes unsafe filename segments when inputs are %j / %j / %j",
  (course, module, title, expected) => {
    // Given / When
    const result = safeDownloadPath(course, module, title);
    // Then
    expect(result).toBe(expected);
    expect(validDownloadPath(result)).toBe(true);
  },
);
it("bounds segments and rejects an overlong combined path", () => {
  // Given
  const long = "a".repeat(200);
  // When / Then
  expect(
    safeDownloadPath("Course", "Week", long)?.split("/").at(-1),
  ).toHaveLength(80);
  expect(safeDownloadPath(long, long, long)).toBeNull();
});
it.each([
  "/uniDock/A/B/file.pdf",
  "uniDock/../B/file.pdf",
  "uniDock/A/./file.pdf",
  "uniDock/A/B/../../file.pdf",
  "uniDock/A/B/C:\\file.pdf",
  "uniDock/A/B/file\u0001.pdf",
  "uniDock/A/B/.pdf",
  "uniDock/A//file.pdf",
  "uniDock/A/B/file.exe",
  "uniDock/A/B/file.pdf ",
  "uniDock/A/B/" + "x".repeat(81) + ".pdf",
])("rejects caller-supplied unsafe path %j", (value) => {
  // Given / When / Then
  expect(validDownloadPath(value)).toBe(false);
});
it("accepts only the closed download request and expected response", () => {
  // Given
  const request = {
    version: 1,
    type: "DOCUMENT_DOWNLOAD",
    handle: crypto.randomUUID(),
    course: "Course",
  } as const;
  const success = { status: "success", downloaded: true };
  // When / Then
  expect(isRequest(request)).toBe(true);
  for (const invalid of [
    { ...request, url },
    { ...request, handle: "fake" },
    { ...request, course: "" },
    { ...request, course: "a".repeat(2001) },
    { ...request, course: "token=secret" },
  ])
    expect(isRequest(invalid)).toBe(false);
  expect(parseResult(success, request)).toEqual(success);
  for (const expected of [
    undefined,
    { version: 1, type: "COURSES_LIST" } as const,
    { version: 1, type: "DOCUMENT_OPEN", handle: request.handle } as const,
  ])
    expect(parseResult(success, expected)).toEqual({
      status: "error",
      code: "INVALID_RESPONSE",
    });
  expect(parseResult({ ...success, downloadId: 1 }, request)).toEqual({
    status: "error",
    code: "INVALID_RESPONSE",
  });
});
