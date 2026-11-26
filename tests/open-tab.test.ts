import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { lectureTabKey, openLmsTab, verifyLectureTab } from "../src/open-tab";

const origin = "https://mylms.korea.ac.kr";
const lecture = `${origin}/courses/101/modules/items/501`;
let session: Record<string, unknown>;
let tabs: Map<number, { url?: string }>;
const create = vi.fn();
const update = vi.fn();
const executeScript = vi.fn();
let nextSender = 100;

beforeEach(() => {
  session = {};
  tabs = new Map();
  create.mockImplementation(async () => ({ id: 9 }));
  update.mockImplementation(async () => ({}));
  vi.stubGlobal("chrome", {
    runtime: { id: "extension" },
    storage: {
      session: {
        get: vi.fn(async (key: string) => ({ [key]: session[key] })),
        set: vi.fn(async (items: Record<string, unknown>) => Object.assign(session, items)),
      },
    },
    tabs: {
      get: vi.fn(async (id: number) => {
        const tab = tabs.get(id);
        if (!tab) throw new Error("No tab");
        return tab;
      }),
      create,
      update,
    },
    scripting: { executeScript },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// Each list tab is fresh so the per-tab open budget never interferes.
function listTab(): number {
  const id = nextSender++;
  tabs.set(id, { url: `${origin}/courses/101/modules` });
  return id;
}

function open(source: number, reuse = true) {
  const sender = { id: "extension", frameId: 0, url: `${origin}/courses/101/modules`, tab: { id: source } };
  const message = { version: 1, type: "OPEN_LMS_TARGET", url: lecture, ...(reuse ? { reuse: true } : {}) };
  return openLmsTab(message, sender as chrome.runtime.MessageSender);
}

const player = "https://kucom.korea.ac.kr/em/0123456789abcdef";
const frame = (frameId: number, documentId: string, result: string) => ({ frameId, documentId, result });

/** A list tab whose lecture tab, tab 9, holds these frames. */
function lectureTab(frames: readonly ReturnType<typeof frame>[]): number {
  const source = listTab();
  session[lectureTabKey(source)] = 9;
  executeScript.mockResolvedValue(frames);
  return source;
}

function verify(source: number, url = lecture, extra: Record<string, unknown> = {}) {
  const sender = { id: "extension", frameId: 0, url: `${origin}/courses/101/modules`, tab: { id: source } };
  const message = { version: 1, type: "VERIFY_LECTURE_TAB", url, document: "PLAYER", ...extra };
  return verifyLectureTab(message, sender as chrome.runtime.MessageSender);
}

it.each([
  ["a module lecture hosting the player in a frame", lecture, [frame(0, "TOP", lecture), frame(4, "PLAYER", player)]],
  ["a board lecture that is the player page", player, [frame(0, "PLAYER", player)]],
])("confirms a player document of %s", async (_case, url, frames) => {
  const source = lectureTab(frames);
  expect(await verify(source, url)).toEqual({ status: "success", verified: true });
  expect(executeScript).toHaveBeenCalledWith({
    target: { tabId: 9, allFrames: true },
    func: expect.any(Function),
  });
});

it.each([
  ["shows another lecture", [frame(0, "TOP", `${origin}/courses/101/modules/items/400`), frame(4, "PLAYER", player)]],
  ["was redirected to the same lecture with a query", [frame(0, "TOP", `${lecture}?redirected=1`), frame(4, "PLAYER", player)]],
  ["no longer holds the player document", [frame(0, "TOP", lecture), frame(4, "OTHER", player)]],
  ["has no readable top frame", [frame(4, "PLAYER", player)]],
])("reports a mismatch when the lecture tab %s", async (_case, frames) => {
  expect(await verify(lectureTab(frames))).toEqual({ status: "error", code: "LECTURE_MISMATCH" });
});

it("reports a mismatch when the lecture tab cannot be read or was never opened", async () => {
  const source = lectureTab([frame(0, "TOP", lecture), frame(4, "PLAYER", player)]);
  executeScript.mockRejectedValueOnce(new Error("No tab"));
  expect(await verify(source)).toEqual({ status: "error", code: "LECTURE_MISMATCH" });
  expect(await verify(listTab())).toEqual({ status: "error", code: "LECTURE_MISMATCH" });
  expect(executeScript).toHaveBeenCalledOnce();
});

it("reads no tab for a forged, malformed or stale question", async () => {
  const source = lectureTab([frame(0, "TOP", lecture), frame(4, "PLAYER", player)]);
  const message = { version: 1, type: "VERIFY_LECTURE_TAB", url: lecture, document: "PLAYER" };
  const sender = { id: "extension", frameId: 0, url: `${origin}/courses/101/modules`, tab: { id: source } };
  for (const forged of [{ ...sender, id: "foreign" }, { ...sender, frameId: 1 }, { ...sender, tab: undefined }])
    expect(await verifyLectureTab(message, forged as chrome.runtime.MessageSender)).toEqual({
      status: "error",
      code: "POLICY",
    });
  for (const extra of [{ document: "a/b" }, { document: 7 }, { reuse: true }])
    expect(await verify(source, lecture, extra)).toEqual({ status: "error", code: "POLICY" });
  expect(await verify(source, "https://evil.invalid/")).toEqual({ status: "error", code: "POLICY" });
  tabs.set(source, { url: `${origin}/courses/102/modules` });
  expect(await verify(source)).toEqual({ status: "error", code: "RELOAD_TAB" });
  expect(executeScript).not.toHaveBeenCalled();
});

it("refuses questions beyond the per-tab budget without reading the tab", async () => {
  const source = lectureTab([frame(0, "TOP", lecture), frame(4, "PLAYER", player)]);
  for (let count = 0; count < 60; count++) expect((await verify(source)).status).toBe("success");
  expect(await verify(source)).toEqual({ status: "error", code: "RATE_LIMITED" });
  expect(executeScript).toHaveBeenCalledTimes(60);
});

it("opens the first lecture in a new tab and remembers it for that list", async () => {
  const source = listTab();
  expect(await open(source)).toEqual({ status: "success", opened: true });
  expect(create).toHaveBeenCalledWith({ url: lecture, active: true });
  expect(session[lectureTabKey(source)]).toBe(9);
});

it.each([
  ["an LMS page", `${origin}/courses/101/modules/items/400`],
  ["a KU player page", "https://kucom.korea.ac.kr/em/0123456789abcdef"],
])("reuses the remembered tab while it shows %s", async (_case, url) => {
  const source = listTab();
  session[lectureTabKey(source)] = 9;
  tabs.set(9, { url });
  expect((await open(source)).status).toBe("success");
  expect(update).toHaveBeenCalledWith(9, { url: lecture, active: true });
  expect(create).not.toHaveBeenCalled();
});

it("keeps a separate lecture tab for each list tab", async () => {
  const first = listTab();
  session[lectureTabKey(first)] = 9;
  tabs.set(9, { url: `${origin}/courses/101/modules/items/400` });
  create.mockResolvedValueOnce({ id: 12 });
  const second = listTab();
  expect((await open(second)).status).toBe("success");
  expect(update).not.toHaveBeenCalled();
  expect(session[lectureTabKey(second)]).toBe(12);
  expect(session[lectureTabKey(first)]).toBe(9);
});

it.each([
  ["closed", undefined],
  ["moved to another site", { url: undefined }],
])("opens a new tab when the remembered one was %s", async (_case, tab) => {
  const source = listTab();
  session[lectureTabKey(source)] = 9;
  if (tab) tabs.set(9, tab);
  create.mockResolvedValueOnce({ id: 12 });
  expect((await open(source)).status).toBe("success");
  expect(update).not.toHaveBeenCalled();
  expect(session[lectureTabKey(source)]).toBe(12);
});

it("never reuses the tab that holds the list", async () => {
  const source = listTab();
  session[lectureTabKey(source)] = source;
  expect((await open(source)).status).toBe("success");
  expect(update).not.toHaveBeenCalled();
  expect(create).toHaveBeenCalledOnce();
});

it("keeps ordinary opens in a new tab and refuses other extra fields", async () => {
  const source = listTab();
  session[lectureTabKey(source)] = 9;
  tabs.set(9, { url: `${origin}/courses/101/modules/items/400` });
  expect((await open(source, false)).status).toBe("success");
  expect(update).not.toHaveBeenCalled();
  const sender = { id: "extension", frameId: 0, url: `${origin}/`, tab: { id: 300 } };
  tabs.set(300, { url: `${origin}/` });
  expect(
    await openLmsTab(
      { version: 1, type: "OPEN_LMS_TARGET", url: lecture, reuse: "yes" },
      sender as chrome.runtime.MessageSender,
    ),
  ).toEqual({ status: "error", code: "POLICY" });
});
