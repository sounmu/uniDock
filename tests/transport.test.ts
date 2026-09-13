import { afterEach, expect, it, vi } from "vitest";
import { queryActiveCourses, queryActive } from "../src/transport";
const url = "https://mylms.korea.ac.kr/";
function setup(tab = { id: 7, url }) {
  const sendMessage = vi.fn().mockResolvedValue({
    status: "success",
    courses: [{ name: "샘플 과목", token: "private" }],
  });
  const get = vi.fn().mockResolvedValue(tab);
  const query = vi.fn().mockResolvedValue([tab]);
  vi.stubGlobal("chrome", {
    tabs: { query, sendMessage, get },
  });
  return { sendMessage, get, query };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it("queries only active top frame and strips extra output fields", async () => {
  const { sendMessage } = setup();
  expect(await queryActiveCourses()).toEqual({
    status: "success",
    courses: [{ name: "샘플 과목" }],
  });
  expect(sendMessage).toHaveBeenCalledWith(
    7,
    { version: 1, type: "COURSES_LIST" },
    { frameId: 0 },
  );
});
it("never messages an unrelated tab", async () => {
  const { sendMessage } = setup({ id: 7, url: "https://example.invalid/" });
  expect(await queryActiveCourses()).toEqual({
    status: "error",
    code: "OPEN_LMS",
  });
  expect(sendMessage).not.toHaveBeenCalled();
});
it("discards results if the tab navigated", async () => {
  const { get } = setup();
  get.mockResolvedValue({ id: 7, url: `${url}login` });
  expect(await queryActiveCourses()).toEqual({
    status: "error",
    code: "RELOAD_TAB",
  });
});
it("handles a missing content script without leaking exceptions", async () => {
  const { sendMessage } = setup();
  sendMessage.mockRejectedValue(new Error("private"));
  expect(await queryActiveCourses()).toEqual({
    status: "error",
    code: "RELOAD_TAB",
  });
});
it("bounds a lost message response", async () => {
  vi.useFakeTimers();
  const { sendMessage } = setup();
  sendMessage.mockReturnValue(new Promise(() => {}));
  const result = queryActiveCourses();
  await vi.advanceTimersByTimeAsync(23000);
  expect(await result).toEqual({ status: "error", code: "TIMEOUT" });
});

it("times out a stalled active-tab query and never messages after it resolves late", async () => {
  vi.useFakeTimers();
  const { get, query, sendMessage } = setup();
  let finishQuery: (tabs: { id: number; url: string }[]) => void = () => {};
  query.mockReturnValue(
    new Promise((resolve) => {
      finishQuery = resolve;
    }),
  );
  const settled = vi.fn();
  void queryActiveCourses().then(settled);

  await vi.advanceTimersByTimeAsync(23000);
  expect.soft(settled).toHaveBeenCalledWith({
    status: "error",
    code: "TIMEOUT",
  });

  finishQuery([{ id: 7, url }]);
  await vi.advanceTimersByTimeAsync(0);
  expect(sendMessage).not.toHaveBeenCalled();
  expect(get).not.toHaveBeenCalled();
});

it("times out a stalled bound-tab lookup and never messages after it resolves late", async () => {
  vi.useFakeTimers();
  const { get, sendMessage } = setup();
  let finishGet: (tab: { id: number; url: string }) => void = () => {};
  get.mockReturnValue(
    new Promise((resolve) => {
      finishGet = resolve;
    }),
  );
  const settled = vi.fn();
  void queryActive(
    { version: 1, type: "RECORDING_OPEN", handle: crypto.randomUUID() },
    { target: { id: 7, url } },
  ).then(settled);

  await vi.advanceTimersByTimeAsync(23000);
  expect.soft(settled).toHaveBeenCalledWith({
    status: "error",
    code: "TIMEOUT",
  });

  finishGet({ id: 7, url });
  await vi.advanceTimersByTimeAsync(0);
  expect(sendMessage).not.toHaveBeenCalled();
});

it("never verifies the tab after a message resolves beyond the deadline", async () => {
  vi.useFakeTimers();
  const { get, sendMessage } = setup();
  let finishMessage: (result: {
    status: "success";
    courses: never[];
  }) => void = () => {};
  sendMessage.mockReturnValue(
    new Promise((resolve) => {
      finishMessage = resolve;
    }),
  );
  const pending = queryActiveCourses();
  await vi.advanceTimersByTimeAsync(0);

  await vi.advanceTimersByTimeAsync(23000);
  expect(await pending).toEqual({ status: "error", code: "TIMEOUT" });

  finishMessage({ status: "success", courses: [] });
  await vi.advanceTimersByTimeAsync(0);
  expect(get).not.toHaveBeenCalled();
});

it("sends new read requests and rejects mismatched result kinds", async () => {
  const { sendMessage } = setup();
  const request = {
    version: 1,
    type: "UPCOMING_LIST",
    start_date: "2026-09-01",
  } as const;
  expect(await queryActive(request)).toEqual({
    status: "error",
    code: "INVALID_RESPONSE",
  });
  expect(sendMessage).toHaveBeenCalledWith(7, request, { frameId: 0 });
  sendMessage.mockResolvedValue({ status: "success", upcoming: [] });
  expect(await queryActive(request)).toEqual({
    status: "success",
    upcoming: [],
  });
});

it.each([
  [url, "https://canvas.korea.ac.kr/courses/12/assignments/34"],
  [
    "https://canvas.korea.ac.kr/",
    "https://mylms.korea.ac.kr/courses/12/assignments/34",
  ],
])(
  "rejects item links returned from the other LMS origin",
  async (tabUrl, html_url) => {
    const { sendMessage } = setup({ id: 7, url: tabUrl });
    const request = { version: 1, type: "UPCOMING_LIST" } as const;
    sendMessage.mockResolvedValue({
      status: "success",
      upcoming: [
        {
          html_url,
          title: "일정",
          date: "2026-09-01",
          type: "assignment",
          course: "샘플 과목",
          submitted: false,
          new_activity: false,
        },
      ],
    });
    expect(await queryActive(request)).toEqual({
      status: "error",
      code: "INVALID_RESPONSE",
    });
  },
);

it("binds recording opens to their listing tab even after the active tab changes", async () => {
  const { sendMessage } = setup();
  sendMessage.mockResolvedValue({ status: "success", opened: true });
  const target = { id: 7, url };
  const handle = crypto.randomUUID();
  expect(
    await queryActive(
      { version: 1, type: "RECORDING_OPEN", handle },
      { target },
    ),
  ).toEqual({ status: "success", opened: true });
  expect(chrome.tabs.query).not.toHaveBeenCalled();
  expect(sendMessage).toHaveBeenCalledWith(
    7,
    { version: 1, type: "RECORDING_OPEN", handle },
    { frameId: 0 },
  );
});
it("rejects a bound tab that navigated before sending an open", async () => {
  const { sendMessage, get } = setup();
  get.mockResolvedValue({ id: 7, url: `${url}other` });
  expect(
    await queryActive(
      { version: 1, type: "RECORDING_OPEN", handle: crypto.randomUUID() },
      { target: { id: 7, url } },
    ),
  ).toEqual({ status: "error", code: "RELOAD_TAB" });
  expect(sendMessage).not.toHaveBeenCalled();
});
it("reports the selected source tab before delivering its result", async () => {
  setup();
  const onTarget = vi.fn();
  await queryActive({ version: 1, type: "COURSES_LIST" }, { onTarget });
  expect(onTarget).toHaveBeenCalledExactlyOnceWith({ id: 7, url });
});
