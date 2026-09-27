import { afterEach, expect, it } from "vitest";
import { NavigationCatalog } from "../src/navigation-catalog";
import { listQuery } from "../src/api/client";
const origin = "https://mylms.korea.ac.kr";
const now = Date.parse("2026-09-26T00:00:00Z");
const catalog = new NavigationCatalog();
const target = {
  module: "Week",
  title: "slides.pdf",
  courseId: "101",
  itemId: "501",
  fileId: "777",
  moduleAccess: {},
  itemAccess: {},
};
afterEach(() => catalog.clear());
it("makes download handles one-use without consuming the document open handle", () => {
  // Given
  const item = catalog.replaceDocuments(origin, [target], now)[0];
  if (!item) throw new Error("Missing document");
  // When
  const taken = catalog.takeDownload(item.downloadHandle, origin, now);
  // Then
  expect(taken).toEqual({
    url: `${origin}/courses/101/files/777/download?download_frd=1`,
    module: "Week",
    title: "slides.pdf",
  });
  expect(catalog.takeDownload(item.downloadHandle, origin, now)).toBeNull();
  expect(catalog.take(item.lmsHandle, origin, now, "document")).toBe(
    `${origin}/courses/101/modules/items/501`,
  );
});
it("terminally revokes a catalog so late hydration cannot mint capabilities", () => {
  const staging = new NavigationCatalog("account-a", 1);
  const item = staging.replaceDocuments(origin, [target], now)[0]!;
  staging.revoke();

  expect(staging.take(item.lmsHandle, origin, now, "document")).toBeNull();
  expect(staging.takeDownload(item.downloadHandle, origin, now)).toBeNull();
  expect(() => staging.replaceDocuments(origin, [target], now)).toThrow(
    "STALE_SELECTION",
  );
  expect(staging.ownedBy("account-a", 1)).toBe(false);
});
it.each([
  "expired",
  "locked",
  "cross-origin",
  "open-as-download",
  "download-as-open",
])("rejects a %s capability", (kind) => {
  // Given
  const item = catalog.replaceDocuments(
    origin,
    [
      {
        ...target,
        moduleAccess:
          kind === "locked" ? { lock_at: "2026-09-26T00:00:01Z" } : {},
      },
    ],
    now,
  )[0];
  if (!item) throw new Error("Missing document");
  // When
  const value =
    kind === "download-as-open"
      ? catalog.take(item.downloadHandle, origin, now, "document")
      : catalog.takeDownload(
          kind === "open-as-download" ? item.lmsHandle : item.downloadHandle,
          kind === "cross-origin" ? "https://canvas.korea.ac.kr" : origin,
          now + (kind === "expired" ? 300000 : kind === "locked" ? 1000 : 0),
        );
  // Then
  expect(value).toBeNull();
});
it.each([undefined, 0, "invalid", "777?download_frd=1"])(
  "offers only LMS opening when content_id is %j",
  async (content_id) => {
    // Given
    const fetcher: typeof fetch = async (input) =>
      Response.json(
        String(input).includes("/modules?")
          ? [
              {
                id: 1,
                name: "Week",
                items_count: 1,
                items: [
                  {
                    id: 501,
                    type: "File",
                    title: "file.pdf",
                    content_id,
                    html_url: `${origin}/courses/101/files/777/download?download_frd=1`,
                  },
                ],
              },
            ]
          : [{ id: 101, name: "Course" }],
      );
    // When
    const result = await listQuery(
      origin,
      { version: 1, type: "DOCUMENTS_LIST", course: "Course" },
      fetcher,
      now,
      catalog,
    );
    // Then
    expect(result).toMatchObject({
      status: "success",
      documents: [{ downloadHandle: "" }],
    });
  },
);
