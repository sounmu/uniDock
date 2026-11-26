import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { lectureTabKey, openLmsTab } from "../src/open-tab";

const origin = "https://mylms.korea.ac.kr";
const lecture = `${origin}/courses/101/modules/items/501`;
let session: Record<string, unknown>;
let tabs: Map<number, { url?: string }>;
const create = vi.fn();
const update = vi.fn();
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
