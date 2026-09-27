// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mount, click, deferred } from "./ui-helpers";
import type { Result } from "../src/protocol";
const query = vi.hoisted(() => vi.fn());
vi.mock("../src/transport", () => ({ queryActive: query }));
import { App } from "../entrypoints/sidepanel/App";
let ui: Awaited<ReturnType<typeof mount>>;
const onCreated = { addListener: vi.fn(), removeListener: vi.fn() };
const onChanged = { addListener: vi.fn(), removeListener: vi.fn() };
const search = vi.fn();
const target = { id: 7, url: "https://mylms.korea.ac.kr/" };
const documents = ["one.pdf", "two.pdf", "no-id.pdf"].map((title, index) => ({
  module: "Week",
  title,
  type: "File" as const,
  lmsHandle: crypto.randomUUID(),
  downloadHandle: index === 2 ? "" : crypto.randomUUID(),
}));
beforeEach(() => {
  vi.stubGlobal("chrome", {
    runtime: { id: "test" },
    downloads: { onCreated, onChanged, search },
  });
});
afterEach(async () => {
  await ui?.unmount();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});
async function materials() {
  query
    .mockResolvedValueOnce({ status: "success", courses: [{ name: "Course" }] })
    .mockResolvedValueOnce({ status: "success", assignments: [] })
    .mockImplementationOnce(async (_request, options) => {
      options.onTarget(target);
      return { status: "success", documents };
    });
  ui = await mount(<App />);
  await click("새로고침");
  await click("Course");
  await click("수업 자료");
}
const chips = () =>
  [...document.querySelectorAll(".status-chip")].map(
    (item) => item.textContent,
  );
it("requests all downloadable files sequentially and marks a failed item without replay", async () => {
  // Given
  await materials();
  const first = deferred<Result>();
  query
    .mockReturnValueOnce(first.promise)
    .mockResolvedValueOnce({ status: "error", code: "DOWNLOAD_FAILED" });
  // When
  await click("PDF 전체 다운로드");
  expect(query).toHaveBeenCalledTimes(4);
  await act(async () => first.resolve({ status: "success", downloaded: true }));
  // Then
  expect(query.mock.calls.slice(3)).toEqual(
    documents.slice(0, 2).map((item) => [
      {
        version: 1,
        type: "DOCUMENT_DOWNLOAD",
        handle: item.downloadHandle,
        course: "Course",
      },
      { target },
    ]),
  );
  expect(chips()).toEqual(["요청됨", "실패", "LMS에서 확인"]);
  expect(document.body.textContent).toContain("2/2");
  await click("PDF 전체 다운로드");
  expect(query).toHaveBeenCalledTimes(5);
});
it("downloads only the checked subset and keeps selection when returning from details", async () => {
  // Given
  await materials();
  query.mockResolvedValue({ status: "success", downloaded: true });
  const checkbox = document.querySelector<HTMLInputElement>(
    'input[aria-label="two.pdf 선택"]',
  );
  if (!checkbox) throw new Error("Missing checkbox");
  await act(async () => checkbox.click());
  // When
  await click("two.pdf");
  await click("← 목록");
  await click("선택 다운로드 (1)");
  // Then
  expect(checkbox.checked).toBe(true);
  expect(query.mock.calls.slice(3).map(([request]) => request.handle)).toEqual([
    documents[1]?.downloadHandle,
  ]);
  expect(chips()).toEqual(["대기", "요청됨", "LMS에서 확인"]);
});
it.each(["할 일·일정", "취소"])(
  "stops unsent downloads when %s is selected",
  async (action) => {
    // Given
    await materials();
    const first = deferred<Result>();
    query
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue({ status: "success", todo: [] });
    await click("PDF 전체 다운로드");
    // When
    await click(action);
    await act(async () =>
      first.resolve({ status: "success", downloaded: true }),
    );
    // Then
    expect(
      query.mock.calls.filter(
        ([request]) => request.type === "DOCUMENT_DOWNLOAD",
      ),
    ).toHaveLength(1);
    if (action === "취소")
      expect(chips()).toEqual(["요청됨", "취소됨", "LMS에서 확인"]);
  },
);
it("requires refresh when the download capability has expired", async () => {
  // Given
  await materials();
  query.mockResolvedValue({ status: "error", code: "STALE_SELECTION" });
  // When
  await click("PDF 전체 다운로드");
  // Then
  expect(chips()).toEqual(["실패", "실패", "LMS에서 확인"]);
  expect(
    document.querySelector<HTMLButtonElement>(".screen-header .btn-primary")
      ?.disabled,
  ).toBe(true);
  expect(document.querySelector(".notice")?.getAttribute("role")).toBe(
    "status",
  );
});
it.each([
  ["application/pdf", "완료"],
  ["text/html", "확인 필요"],
])(
  "tracks a completed matching download with MIME %s",
  async (mime, status) => {
    // Given
    await materials();
    query.mockResolvedValue({ status: "success", downloaded: true });
    const item = {
      id: 42,
      byExtensionId: "test",
      url: `${target.url}courses/101/files/501/download?download_frd=1`,
      filename: "/Downloads/uniDock/Course/Week/one.pdf",
      state: "in_progress",
      mime,
    };
    // When
    await click("PDF 전체 다운로드");
    await act(async () => {
      onCreated.addListener.mock.calls[0]?.[0]({
        ...item,
        byExtensionId: undefined,
      });
    });
    search.mockResolvedValue([{ ...item, state: "complete" }]);
    await act(async () => {
      onChanged.addListener.mock.calls[0]?.[0]({
        id: 42,
        state: { current: "complete" },
      });
    });
    // Then
    expect(chips()).toEqual([status, "요청됨", "LMS에서 확인"]);
    expect(search).toHaveBeenCalledWith({ id: 42 });
  },
);
it("leaves unassociated and foreign download events unconfirmed", async () => {
  // Given
  await materials();
  query.mockResolvedValue({ status: "success", downloaded: true });
  await click("PDF 전체 다운로드");
  // When
  await act(async () => {
    onCreated.addListener.mock.calls[0]?.[0]({
      id: 42,
      byExtensionId: "foreign",
      url: `${target.url}courses/101/files/501/download?download_frd=1`,
      filename: "/Downloads/uniDock/Course/Week/one.pdf",
      state: "complete",
      mime: "application/pdf",
    });
    onChanged.addListener.mock.calls[0]?.[0]({
      id: 42,
      state: { current: "complete" },
    });
  });
  // Then
  expect(chips()).toEqual(["요청됨", "요청됨", "LMS에서 확인"]);
  expect(search).not.toHaveBeenCalled();
});
it("does not bind a stale download search to a refreshed matching row", async () => {
  // Given: the old download emits a change, but Chrome holds its lookup.
  await materials();
  query.mockResolvedValue({ status: "success", downloaded: true });
  await click("PDF 전체 다운로드");
  const oldItem = {
    id: 42,
    byExtensionId: "test",
    url: `${target.url}courses/101/files/501/download?download_frd=1`,
    filename: "/Downloads/uniDock/Course/Week/one.pdf",
    state: "in_progress",
    mime: "application/pdf",
  };
  await act(async () => {
    onCreated.addListener.mock.calls[0]?.[0]({
      ...oldItem,
      byExtensionId: undefined,
    });
  });
  const heldSearch = deferred<chrome.downloads.DownloadItem[]>();
  search.mockReturnValueOnce(heldSearch.promise);
  await act(async () => {
    onChanged.addListener.mock.calls[0]?.[0]({
      id: oldItem.id,
      state: { current: "complete" },
    });
  });

  // When: refresh creates the same expected path and the old lookup resolves.
  query.mockImplementationOnce(async (_request, options) => {
    options.onTarget(target);
    return { status: "success", documents };
  });
  await click("목록 새로고침");
  await click("PDF 전체 다운로드");
  await act(async () => {
    heldSearch.resolve([
      { ...oldItem, state: "complete" } as chrome.downloads.DownloadItem,
    ]);
  });

  // Then: only an event from the new download can complete the refreshed row.
  expect(chips()).toEqual(["요청됨", "요청됨", "LMS에서 확인"]);
  const newItem = { ...oldItem, id: 43 };
  search.mockResolvedValueOnce([
    { ...newItem, state: "complete" } as chrome.downloads.DownloadItem,
  ]);
  await act(async () => {
    onCreated.addListener.mock.calls[0]?.[0](newItem);
    onChanged.addListener.mock.calls[0]?.[0]({
      id: newItem.id,
      state: { current: "complete" },
    });
  });
  expect(chips()).toEqual(["완료", "요청됨", "LMS에서 확인"]);
});
it("continues tracking a started download after cancelling pending batch items", async () => {
  // Given
  await materials();
  const first = deferred<Result>();
  query.mockReturnValueOnce(first.promise);
  await click("PDF 전체 다운로드");
  const item = {
    id: 42,
    byExtensionId: "test",
    url: `${target.url}courses/101/files/501/download?download_frd=1`,
    filename: "/Downloads/uniDock/Course/Week/one.pdf",
    state: "in_progress",
    mime: "application/pdf",
  };
  await act(async () => {
    onCreated.addListener.mock.calls[0]?.[0](item);
  });

  // When
  await click("취소");
  await act(async () => first.resolve({ status: "success", downloaded: true }));
  search.mockResolvedValueOnce([
    { ...item, state: "complete" } as chrome.downloads.DownloadItem,
  ]);
  await act(async () => {
    onChanged.addListener.mock.calls[0]?.[0]({
      id: item.id,
      state: { current: "complete" },
    });
  });

  // Then
  expect(chips()).toEqual(["완료", "취소됨", "LMS에서 확인"]);
});
it("ignores a held download search after unmount", async () => {
  // Given
  await materials();
  query.mockResolvedValue({ status: "success", downloaded: true });
  await click("PDF 전체 다운로드");
  const item = {
    id: 42,
    byExtensionId: undefined,
    url: `${target.url}courses/101/files/501/download?download_frd=1`,
    filename: "/Downloads/uniDock/Course/Week/one.pdf",
    state: "in_progress",
    mime: "application/pdf",
  };
  await act(async () => {
    onCreated.addListener.mock.calls[0]?.[0](item);
  });
  const heldSearch = deferred<chrome.downloads.DownloadItem[]>();
  search.mockReturnValueOnce(heldSearch.promise);
  await act(async () => {
    onChanged.addListener.mock.calls[0]?.[0]({
      id: item.id,
      state: { current: "complete" },
    });
  });

  // When
  await ui.unmount();
  await act(async () => {
    heldSearch.resolve([
      {
        ...item,
        byExtensionId: "test",
        state: "complete",
      } as chrome.downloads.DownloadItem,
    ]);
  });

  // Then
  expect(onCreated.removeListener).toHaveBeenCalled();
  expect(onChanged.removeListener).toHaveBeenCalled();
});
