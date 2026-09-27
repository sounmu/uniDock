import { afterEach, expect, it, vi } from "vitest";
import { downloadLmsFile } from "../src/download-tab";
const origin = "https://mylms.korea.ac.kr";
const message = {
  version: 1,
  type: "DOWNLOAD_LMS_FILE",
  deadline: Date.now() + 23_000,
  url: `${origin}/courses/101/files/501/download?download_frd=1`,
  filename: "uniDock/Course/Week/slides.pdf",
};
const sender: chrome.runtime.MessageSender = {
  id: "fixture",
  frameId: 0,
  documentId: "document-a",
  url: `${origin}/courses/101`,
  tab: {
    id: 7,
    index: 0,
    pinned: false,
    highlighted: true,
    windowId: 1,
    active: true,
    incognito: false,
    selected: true,
    frozen: false,
    discarded: false,
    autoDiscardable: true,
    groupId: -1,
    lastAccessed: 0,
  },
};
function setup() {
  const download = vi.fn().mockResolvedValue(1),
    get = vi.fn().mockResolvedValue({ url: sender.url }),
    sendMessage = vi.fn(
      async (_tabId: number, challenge: { nonce: string }) => ({
        version: 1,
        type: "DOWNLOAD_SOURCE_OK",
        nonce: challenge.nonce,
      }),
    );
  vi.stubGlobal("chrome", {
    runtime: { id: "fixture" },
    tabs: { get, sendMessage },
    downloads: { download },
  });
  return { download, get, sendMessage };
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it("requests one browser download when sender, route and filename are canonical", async () => {
  // Given
  const { download, get } = setup();
  // When
  const result = await downloadLmsFile(message, sender);
  // Then
  expect(result).toEqual({ status: "success", downloaded: true });
  expect(get).toHaveBeenCalledWith(7);
  expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
    7,
    expect.objectContaining({ version: 1, type: "DOWNLOAD_SOURCE_CHECK" }),
    { frameId: 0, documentId: "document-a" },
  );
  expect(download).toHaveBeenCalledExactlyOnceWith({
    url: message.url,
    filename: message.filename,
    conflictAction: "uniquify",
    saveAs: false,
  });
});
it.each([
  { ...sender, id: "foreign" },
  { ...sender, frameId: 1 },
  { ...sender, tab: undefined },
  { ...sender, documentId: undefined },
  { ...sender, url: undefined },
  { ...sender, url: "https://canvas.korea.ac.kr/" },
])("rejects a forged sender before browser download", async (source) => {
  // Given
  const { download } = setup();
  // When
  const result = await downloadLmsFile(message, source);
  // Then
  expect(result).toEqual({ status: "error", code: "POLICY" });
  expect(download).not.toHaveBeenCalled();
});
it.each([
  { ...message, extra: 1 },
  { ...message, version: 2 },
  Object.fromEntries(
    Object.entries(message).filter(([key]) => key !== "deadline"),
  ),
  { ...message, deadline: Date.now() + 60_000 },
  { ...message, deadline: 1.5 },
  { ...message, url: message.url + "&x=1" },
  { ...message, url: null },
  { ...message, filename: "uniDock/../x.pdf" },
  { ...message, filename: "/tmp/x.pdf" },
  { ...message, filename: "uniDock/A/B/C:\\x.pdf" },
])("rejects URL or filename tampering", async (value) => {
  // Given
  const { download } = setup();
  // When
  const result = await downloadLmsFile(value, sender);
  // Then
  expect(result).toEqual({ status: "error", code: "POLICY" });
  expect(download).not.toHaveBeenCalled();
});
it("does not initiate a download when tab lookup crosses the deadline", async () => {
  vi.useFakeTimers();
  const { download, get, sendMessage } = setup();
  let finish!: (tab: { url: string | undefined }) => void;
  get.mockReturnValue(new Promise((resolve) => (finish = resolve)));
  const pending = downloadLmsFile(
    { ...message, deadline: Date.now() + 23_000 },
    sender,
  );

  await vi.advanceTimersByTimeAsync(23_000);
  finish({ url: sender.url });
  await vi.advanceTimersByTimeAsync(0);

  expect(await pending).toEqual({ status: "error", code: "TIMEOUT" });
  expect(sendMessage).not.toHaveBeenCalled();
  expect(download).not.toHaveBeenCalled();
  vi.useRealTimers();
});
it("rejects a replacement document even when its URL is unchanged", async () => {
  const { download, sendMessage } = setup();
  sendMessage.mockRejectedValue(new Error("No document with given id"));

  expect(await downloadLmsFile(message, sender)).toEqual({
    status: "error",
    code: "RELOAD_TAB",
  });
  expect(download).not.toHaveBeenCalled();
});
it("refuses a stale tab before requesting a download", async () => {
  // Given
  const { download, get } = setup();
  get.mockResolvedValue({ url: `${origin}/courses/202` });
  // When
  const result = await downloadLmsFile(message, sender);
  // Then
  expect(result).toEqual({ status: "error", code: "RELOAD_TAB" });
  expect(download).not.toHaveBeenCalled();
});
it("drops browser error details when starting a download fails", async () => {
  // Given
  const { download } = setup();
  download.mockRejectedValue(new Error("token=secret"));
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  // When
  const result = await downloadLmsFile(message, sender);
  // Then
  expect(result).toEqual({ status: "error", code: "DOWNLOAD_FAILED" });
  expect(log.mock.calls.flat().join(" ")).not.toContain("secret");
});
