import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LECTURE_TAB_KEY, openLmsTab } from "../src/open-tab";

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

// Each call comes from a fresh LMS tab so the per-tab open budget never interferes.
function open(reuse: boolean) {
  const id = nextSender++;
  tabs.set(id, { url: `${origin}/courses/101/modules` });
  const sender = { id: "extension", frameId: 0, url: `${origin}/courses/101/modules`, tab: { id } };
  const message = { version: 1, type: "OPEN_LMS_TARGET", url: lecture, ...(reuse ? { reuse: true } : {}) };
  return { id, result: openLmsTab(message, sender as chrome.runtime.MessageSender) };
}

it("opens the first lecture in a new tab and remembers it", async () => {
  expect(await open(true).result).toEqual({ status: "success", opened: true });
  expect(create).toHaveBeenCalledWith({ url: lecture, active: true });
  expect(session[LECTURE_TAB_KEY]).toBe(9);
});

it("reuses the remembered tab while it still shows an LMS page", async () => {
  session[LECTURE_TAB_KEY] = 9;
  tabs.set(9, { url: `${origin}/courses/101/modules/items/400` });
  expect((await open(true).result).status).toBe("success");
  expect(update).toHaveBeenCalledWith(9, { url: lecture, active: true });
  expect(create).not.toHaveBeenCalled();
});

it.each([
  ["closed", undefined],
  ["moved to another site", { url: undefined }],
])("opens a new tab when the remembered one was %s", async (_case, tab) => {
  session[LECTURE_TAB_KEY] = 9;
  if (tab) tabs.set(9, tab);
  create.mockResolvedValueOnce({ id: 12 });
  expect((await open(true).result).status).toBe("success");
  expect(update).not.toHaveBeenCalled();
  expect(session[LECTURE_TAB_KEY]).toBe(12);
});

it("never reuses the tab that holds the list", async () => {
  const id = nextSender;
  session[LECTURE_TAB_KEY] = id;
  expect((await open(true).result).status).toBe("success");
  expect(update).not.toHaveBeenCalled();
  expect(create).toHaveBeenCalledOnce();
});

it("keeps ordinary opens in a new tab and refuses other extra fields", async () => {
  session[LECTURE_TAB_KEY] = 9;
  tabs.set(9, { url: `${origin}/courses/101/modules/items/400` });
  expect((await open(false).result).status).toBe("success");
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
