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
const createTab = vi.fn();
const writeText = vi.fn();
const target = { id: 7, url: "https://mylms.korea.ac.kr/" };
const courseSelector = "00000000-0000-4000-8000-000000000001";
const documents = ["one.pdf", "two.pdf", "no-id.pdf"].map((title, index) => ({
  module: "Week",
  title,
  type: "File" as const,
  lmsHandle: crypto.randomUUID(),
  downloadHandle: index === 2 ? "" : crypto.randomUUID(),
}));
beforeEach(() => {
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  vi.stubGlobal("chrome", {
    runtime: { id: "test" },
    downloads: {
      onCreated,
      onChanged,
      search,
      showDefaultFolder: vi.fn(),
    },
    tabs: { create: createTab },
  });
});
afterEach(async () => {
  await ui?.unmount();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});
async function materials() {
  query
    .mockImplementationOnce(async (_request, options) => {
      options.onTarget(target);
      return {
        status: "success",
        courses: [{ name: "Course", courseSelector }],
      };
    })
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
it("does not offer a restart until a cancelled request has drained", async () => {
  await materials();
  const first = deferred<Result>();
  query
    .mockReturnValueOnce(first.promise)
    .mockResolvedValue({ status: "success", downloaded: true });
  await click("PDF 전체 다운로드");
  await click("취소");
  const restart = () =>
    [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "PDF 전체 다운로드",
    );
  expect(restart()).toBeUndefined();
  await act(async () => first.resolve({ status: "success", downloaded: true }));
  await click("PDF 전체 다운로드");
  expect(query.mock.calls.slice(4).map(([request]) => request.handle)).toEqual([
    documents[1]?.downloadHandle,
  ]);
  expect(
    document.querySelector('progress[aria-label="PDF 다운로드 진행률"]'),
  ).not.toBeNull();
});
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
it("tracks a download that Chrome saved under a uniquified filename", async () => {
  await materials();
  query.mockResolvedValue({ status: "success", downloaded: true });
  await click("PDF 전체 다운로드");
  await act(async () => {
    onCreated.addListener.mock.calls[0]?.[0]({
      id: 42,
      byExtensionId: "test",
      url: `${target.url}courses/101/files/501/download?download_frd=1`,
      filename: "/Downloads/uniDock/Course/Week/one (1).pdf",
      state: "complete",
      mime: "application/pdf",
    });
  });
  expect(chips()).toEqual(["완료", "요청됨", "LMS에서 확인"]);
});
it.each([
  ["application/pdf", "완료"],
  ["text/html", "확인 필요"],
])(
  "keeps an observed %s completion when the request acknowledgement times out",
  async (mime, status) => {
    await materials();
    const acknowledgement = deferred<Result>();
    query.mockReturnValueOnce(acknowledgement.promise);
    const checkbox = document.querySelector<HTMLInputElement>(
      'input[aria-label="one.pdf 선택"]',
    );
    if (!checkbox) throw new Error("Missing checkbox");
    await act(async () => checkbox.click());
    await click("선택 다운로드 (1)");
    await act(async () => {
      onCreated.addListener.mock.calls[0]?.[0]({
        id: 42,
        byExtensionId: "test",
        url: `${target.url}courses/101/files/501/download?download_frd=1`,
        filename: "/Downloads/uniDock/Course/Week/one.pdf",
        state: "complete",
        mime,
      });
      acknowledgement.resolve({ status: "error", code: "TIMEOUT" });
    });
    expect(chips()).toEqual([status, "대기", "LMS에서 확인"]);
    expect(document.body.textContent).not.toContain(
      "PDF 다운로드를 시작하지 못했습니다",
    );
  },
);
it("keeps tracking an observed in-progress download after an acknowledgement timeout", async () => {
  await materials();
  const acknowledgement = deferred<Result>();
  query.mockReturnValueOnce(acknowledgement.promise);
  const checkbox = document.querySelector<HTMLInputElement>(
    'input[aria-label="one.pdf 선택"]',
  );
  if (!checkbox) throw new Error("Missing checkbox");
  await act(async () => checkbox.click());
  await click("선택 다운로드 (1)");
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
    acknowledgement.resolve({ status: "error", code: "TIMEOUT" });
  });
  expect(chips()).toEqual(["요청됨", "대기", "LMS에서 확인"]);
  expect(document.body.textContent).not.toContain(
    "PDF 다운로드를 시작하지 못했습니다",
  );

  search.mockResolvedValueOnce([
    { ...item, state: "complete" } as chrome.downloads.DownloadItem,
  ]);
  await act(async () => {
    onChanged.addListener.mock.calls[0]?.[0]({
      id: item.id,
      state: { current: "complete" },
    });
  });
  expect(chips()).toEqual(["완료", "대기", "LMS에서 확인"]);
});
it("fails an unobserved download when its acknowledgement errors", async () => {
  await materials();
  query.mockResolvedValueOnce({ status: "error", code: "TIMEOUT" });
  const checkbox = document.querySelector<HTMLInputElement>(
    'input[aria-label="one.pdf 선택"]',
  );
  if (!checkbox) throw new Error("Missing checkbox");
  await act(async () => checkbox.click());
  await click("선택 다운로드 (1)");
  expect(chips()).toEqual(["실패", "대기", "LMS에서 확인"]);
  expect(document.body.textContent).toContain(
    "PDF 다운로드를 시작하지 못했습니다",
  );
});
it("does not preserve an old list observation for a new acknowledgement", async () => {
  await materials();
  const oldAcknowledgement = deferred<Result>();
  query.mockReturnValueOnce(oldAcknowledgement.promise);
  const firstCheckbox = document.querySelector<HTMLInputElement>(
    'input[aria-label="one.pdf 선택"]',
  );
  if (!firstCheckbox) throw new Error("Missing checkbox");
  await act(async () => firstCheckbox.click());
  await click("선택 다운로드 (1)");
  await act(async () => {
    onCreated.addListener.mock.calls[0]?.[0]({
      id: 42,
      byExtensionId: "test",
      url: `${target.url}courses/101/files/501/download?download_frd=1`,
      filename: "/Downloads/uniDock/Course/Week/one.pdf",
      state: "complete",
      mime: "application/pdf",
    });
  });

  query.mockImplementationOnce(async (_request, options) => {
    options.onTarget(target);
    return { status: "success", documents };
  });
  await click("수업 자료");
  await act(async () =>
    oldAcknowledgement.resolve({ status: "error", code: "TIMEOUT" }),
  );
  const newCheckbox = document.querySelector<HTMLInputElement>(
    'input[aria-label="one.pdf 선택"]',
  );
  if (!newCheckbox) throw new Error("Missing refreshed checkbox");
  query.mockResolvedValueOnce({ status: "error", code: "TIMEOUT" });
  await act(async () => newCheckbox.click());
  await click("선택 다운로드 (1)");
  expect(chips()).toEqual(["실패", "대기", "LMS에서 확인"]);
});
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
it.each([
  ["success", true],
  ["denial", false],
] as const)(
  "admits one handoff for rapid clicks after delayed clipboard %s",
  async (_case, succeeds) => {
    await materials();
    query.mockResolvedValue({ status: "success", downloaded: true });
    await click("PDF 전체 다운로드");
    let settle!: () => void;
    const clipboard = new Promise<void>((resolve, reject) => {
      settle = () => (succeeds ? resolve() : reject(new Error("denied")));
    });
    writeText.mockReturnValueOnce(clipboard);
    createTab.mockResolvedValue({});
    const button = [...document.querySelectorAll("button")].find((item) =>
      item.textContent?.includes("ChatGPT에서 질문하기"),
    );
    if (!button) throw new Error("Missing handoff button");

    await act(async () => {
      button.click();
      button.click();
    });

    expect(writeText).toHaveBeenCalledOnce();
    expect(createTab).not.toHaveBeenCalled();
    expect(button.disabled).toBe(true);
    await act(async () => settle());
    expect(createTab).toHaveBeenCalledExactlyOnceWith({
      url: "https://chatgpt.com/",
    });
    expect(button.disabled).toBe(false);
    expect(document.body.textContent).toContain(
      succeeds ? "질문을 복사했습니다." : "질문을 복사하지 못했습니다.",
    );
  },
);
it("does not open or publish a notice when unmounted during clipboard write", async () => {
  await materials();
  query.mockResolvedValue({ status: "success", downloaded: true });
  await click("PDF 전체 다운로드");
  const clipboard = deferred<void>();
  writeText.mockReturnValueOnce(clipboard.promise);
  await click("ChatGPT에서 질문하기 ↗");

  await ui.unmount();
  await act(async () => clipboard.resolve());

  expect(createTab).not.toHaveBeenCalled();
  expect(document.body.textContent).not.toContain("질문을 복사했습니다.");
});
it("lets a new course handoff proceed without an old completion unlocking it", async () => {
  await materials();
  query.mockResolvedValue({ status: "success", downloaded: true });
  await click("PDF 전체 다운로드");
  const oldClipboard = deferred<void>();
  const newClipboard = deferred<void>();
  writeText
    .mockReturnValueOnce(oldClipboard.promise)
    .mockReturnValueOnce(newClipboard.promise);
  createTab.mockResolvedValue({});
  await click("ChatGPT에서 질문하기 ↗");

  query
    .mockImplementationOnce(async (_request, options) => {
      options.onTarget(target);
      return {
        status: "success",
        courses: [
          {
            name: "New Course",
            courseSelector: "00000000-0000-4000-8000-000000000002",
          },
        ],
      };
    })
    .mockResolvedValueOnce({ status: "success", assignments: [] })
    .mockImplementationOnce(async (_request, options) => {
      options.onTarget(target);
      return { status: "success", documents };
    });
  await click("← 과목 선택");
  expect(document.body.textContent).not.toContain("질문을 복사했습니다.");
  await click("New Course");
  await click("수업 자료");
  query.mockResolvedValue({ status: "success", downloaded: true });
  await click("PDF 전체 다운로드");
  await click("ChatGPT에서 질문하기 ↗");
  expect(writeText).toHaveBeenCalledTimes(2);
  const newButton = [...document.querySelectorAll("button")].find((item) =>
    item.textContent?.includes("ChatGPT에서 질문하기"),
  );
  if (!newButton) throw new Error("Missing new handoff button");

  await act(async () => oldClipboard.resolve());
  expect(createTab).not.toHaveBeenCalled();
  expect(newButton.disabled).toBe(true);
  expect(document.body.textContent).not.toContain("질문을 복사했습니다.");

  await act(async () => newClipboard.resolve());
  expect(createTab).toHaveBeenCalledOnce();
  expect(newButton.disabled).toBe(false);
});
