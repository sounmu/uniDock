// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { mount, click } from "./ui-helpers";

const command = vi.hoisted(() => vi.fn());
const query = vi.hoisted(() => vi.fn());
vi.mock("../src/playback/bridge", () => ({ playbackCommand: command }));
vi.mock("../src/transport", () => ({ queryActive: query }));
import { PlaybackPanel } from "../entrypoints/sidepanel/PlaybackPanel";
import { ScreenHeader } from "../entrypoints/sidepanel/ui/ScreenHeader";
import { ListRow } from "../entrypoints/sidepanel/ui/ListRow";
import { PlaybackConfirmation } from "../entrypoints/sidepanel/screens/PlaybackConfirmation";
import type { PlaybackModel } from "../entrypoints/sidepanel/usePlaybackPanel";
import type { PlaybackSnapshot } from "../src/playback/bridge";

let ui: Awaited<ReturnType<typeof mount>>;
afterEach(async () => {
  await ui?.unmount();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

const idle: PlaybackSnapshot = {
  courses: [{ id: "12", name: "역사" }],
  labels: { "12:34": "운영체제 1강", "12:35": "운영체제 2강" },
  current: null,
  queue: [],
  status: "idle",
};

it("renders screen headers with and without optional content", async () => {
  ui = await mount(<ScreenHeader title="자동 재생" />);
  expect(ui.host.textContent).toBe("자동 재생");
  await ui.unmount();
  ui = await mount(<ScreenHeader title="자동 재생" subtitle="선택 재생" />);
  expect(ui.host.textContent).toContain("선택 재생");
});

it("renders a disabled list row without an optional status chip", async () => {
  ui = await mount(
    <ListRow title="영상" course="과목" disabled onClick={() => {}} />,
  );
  expect(ui.host.querySelector("button")?.disabled).toBe(true);
});

it("keeps the selection view open when immediate playback cannot start", async () => {
  const startSelected = vi.fn().mockResolvedValue(false);
  const model = {
    snapshot: idle,
    error: "",
    pending: false,
    recordings: [
      {
        title: "영상",
        module: "1주",
        lmsHandle: "00000000-0000-4000-8000-000000000001",
        launchHandle: "00000000-0000-4000-8000-000000000001",
        type: "ExternalTool" as const,
        order: 1,
      },
    ],
    course: "12",
    setCourse: vi.fn(),
    deletePrompt: false,
    setDeletePrompt: vi.fn(),
    run: vi.fn(),
    loadRecordings: vi.fn(),
    selectRecording: vi.fn(),
    startSelected,
  } as unknown as PlaybackModel;
  ui = await mount(<PlaybackConfirmation model={model} />);
  await click("자동 재생");
  expect(startSelected).toHaveBeenCalledOnce();
});

function setup(snapshot = idle) {
  let current = snapshot;
  command.mockImplementation(async (request) => {
    if (request.type === "PLAYBACK_START")
      current = {
        ...idle,
        status: "starting",
        current: { id: "12:34", courseId: "12" },
        queue: [{ id: "12:35", courseId: "12" }],
      };
    if (request.type === "PLAYBACK_STOP_ALL") current = idle;
    return { status: "success", snapshot: current };
  });
}

it("shows only immediate playlist controls without scheduling settings or blocked reasons", async () => {
  setup();
  ui = await mount(<PlaybackPanel />);
  expect(command).toHaveBeenCalledWith({ version: 1, type: "PLAYBACK_STATUS" });
  expect(ui.host.textContent).not.toContain("재생 설정");
  expect(ui.host.textContent).not.toContain("대기 사유");
  expect(ui.host.querySelector('input[type="datetime-local"]')).toBeNull();
  const actions = [...ui.host.querySelectorAll(".header-actions button")];
  expect(
    actions.map((button) => [button.textContent, button.className]),
  ).toEqual([
    ["영상 선택", "btn-primary"],
    ["새로고침", "btn-primary"],
  ]);
  await click("영상 선택");
  expect(ui.host.textContent).toContain("체크한 순서대로 바로 재생합니다");
});

it("starts recordings in checkbox click order and moves a rechecked item to the end", async () => {
  setup();
  const handles = [
    "00000000-0000-4000-8000-000000000001",
    "00000000-0000-4000-8000-000000000002",
    "00000000-0000-4000-8000-000000000003",
  ];
  query.mockImplementation(async (_request, options) => {
    options.onTarget({
      id: 7,
      url: "https://mylms.korea.ac.kr/",
      documentToken: "00000000-0000-4000-8000-000000000099",
    });
    return {
      status: "success",
      recordings: [
        {
          title: "첫 영상",
          module: "1주",
          lmsHandle: handles[0],
          launchHandle: handles[0],
          type: "ExternalTool",
        },
        {
          title: "둘째 영상",
          module: "1주",
          lmsHandle: handles[1],
          launchHandle: handles[1],
          type: "ExternalTool",
        },
        {
          title: "셋째 영상",
          module: "2주",
          lmsHandle: handles[2],
          launchHandle: handles[2],
          type: "ExternalTool",
        },
      ],
    };
  });
  ui = await mount(<PlaybackPanel />);
  await click("영상 선택");
  const select = ui.host.querySelector("select")!;
  await act(async () => {
    select.value = "12";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await click("영상 불러오기");
  const choices = [
    ...ui.host.querySelectorAll<HTMLInputElement>(
      '.playback-choice input[type="checkbox"]',
    ),
  ];
  await act(async () => choices[1]!.click());
  await act(async () => choices[0]!.click());
  expect(
    [...ui.host.querySelectorAll(".playback-order")].map(
      (item) => item.textContent,
    ),
  ).toEqual(["2", "1", ""]);
  await act(async () => choices[1]!.click());
  await act(async () => choices[1]!.click());
  expect(
    [...ui.host.querySelectorAll(".playback-order")].map(
      (item) => item.textContent,
    ),
  ).toEqual(["1", "2", ""]);
  await click("자동 재생");
  expect(command).toHaveBeenCalledWith({
    version: 1,
    type: "PLAYBACK_START",
    handles: [handles[0], handles[1]],
    sourceTabId: 7,
    documentToken: "00000000-0000-4000-8000-000000000099",
  });
});

it("does not let a late recording list replace a newer course source", async () => {
  const multiCourse: PlaybackSnapshot = {
    ...idle,
    courses: [
      { id: "12", name: "Course B" },
      { id: "13", name: "Course C" },
    ],
  };
  setup(multiCourse);
  const pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      options: { onTarget: (target: unknown) => void };
    }
  >();
  query.mockImplementation(
    (request, options) =>
      new Promise((resolve) => {
        pending.set(request.course, { resolve, options });
      }),
  );
  ui = await mount(<PlaybackPanel />);
  await click("영상 선택");
  const select = ui.host.querySelector("select")!;
  await act(async () => {
    select.value = "12";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    select.value = "13";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await vi.waitFor(() => expect(pending.size).toBe(2));
  const recording = (handle: string) => ({
    title: "영상",
    module: "1주",
    lmsHandle: handle,
    launchHandle: handle,
    type: "ExternalTool" as const,
  });
  const cHandle = "00000000-0000-4000-8000-000000000003";
  await act(async () => {
    const c = pending.get("Course C")!;
    c.options.onTarget({
      id: 13,
      url: "https://mylms.korea.ac.kr/?source=C",
      documentToken: "00000000-0000-4000-8000-000000000013",
    });
    c.resolve({ status: "success", recordings: [recording(cHandle)] });
  });
  await act(async () => {
    const b = pending.get("Course B")!;
    b.options.onTarget({
      id: 12,
      url: "https://mylms.korea.ac.kr/?source=B",
      documentToken: "00000000-0000-4000-8000-000000000012",
    });
    b.resolve({
      status: "success",
      recordings: [recording("00000000-0000-4000-8000-000000000002")],
    });
  });
  const choice = ui.host.querySelector<HTMLInputElement>(
    '.playback-choice input[type="checkbox"]',
  )!;
  await act(async () => choice.click());
  await click("자동 재생");
  expect(command).toHaveBeenCalledWith({
    version: 1,
    type: "PLAYBACK_START",
    handles: [cHandle],
    sourceTabId: 13,
    documentToken: "00000000-0000-4000-8000-000000000013",
  });
});

it("renders current and next videos and keeps refresh styled like other screens", async () => {
  setup({
    ...idle,
    status: "playing",
    current: { id: "12:34", courseId: "12" },
    queue: [{ id: "12:35", courseId: "12" }],
  });
  ui = await mount(<PlaybackPanel />);
  expect(ui.host.textContent).toContain("운영체제 1강");
  expect(ui.host.textContent).toContain("운영체제 2강");
  const actions = [...ui.host.querySelectorAll(".header-actions button")];
  expect(actions.map((button) => button.textContent)).toEqual([
    "자동 재생 끄기",
    "새로고침",
  ]);
  expect(actions.map((button) => button.className)).toEqual([
    "btn-secondary",
    "btn-primary",
  ]);
  await click("새로고침");
  await click("자동 재생 끄기");
  expect(command.mock.calls.map(([request]) => request.type)).toEqual(
    expect.arrayContaining(["PLAYBACK_REFRESH", "PLAYBACK_STOP_ALL"]),
  );
});

it("keeps stop available during refresh and ignores the stale refresh result", async () => {
  const playing: PlaybackSnapshot = {
    ...idle,
    status: "playing",
    current: { id: "12:34", courseId: "12" },
    queue: [],
  };
  let releaseRefresh!: (value: {
    status: "success";
    snapshot: PlaybackSnapshot;
  }) => void;
  const refresh = new Promise<{
    status: "success";
    snapshot: PlaybackSnapshot;
  }>((resolve) => {
    releaseRefresh = resolve;
  });
  command.mockImplementation(async (request) => {
    if (request.type === "PLAYBACK_STATUS")
      return { status: "success", snapshot: playing };
    if (request.type === "PLAYBACK_REFRESH") return refresh;
    if (request.type === "PLAYBACK_STOP_ALL")
      return { status: "success", snapshot: idle };
    throw new Error("unexpected command");
  });
  ui = await mount(<PlaybackPanel />);

  const stop = [...ui.host.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "자동 재생 끄기",
  );
  expect(stop?.disabled).toBe(false);
  await act(async () => stop?.click());
  expect(ui.host.textContent).toContain("자동 재생 · 대기");

  await act(async () =>
    releaseRefresh({ status: "success", snapshot: playing }),
  );
  expect(ui.host.textContent).toContain("자동 재생 · 대기");
  expect(ui.host.textContent).not.toContain("운영체제 1강");
});

it("preserves a login-blocked playlist and offers explicit session recovery", async () => {
  setup({
    ...idle,
    status: "blocked-login",
    current: null,
    queue: [{ id: "12:34", courseId: "12" }],
  });
  ui = await mount(<PlaybackPanel />);
  expect(ui.host.textContent).toContain("재생목록은 보존됩니다");
  expect(
    ui.host.querySelector<HTMLAnchorElement>(
      'a[href="https://mylms.korea.ac.kr/"]',
    ),
  ).not.toBeNull();
  await click("로그인 확인 후 재개");
  expect(command).toHaveBeenCalledWith({
    version: 1,
    type: "PLAYBACK_RESUME",
  });
});

it("offers explicit resume for a paused playlist", async () => {
  setup({
    ...idle,
    status: "paused",
    current: { id: "12:34", courseId: "12" },
    queue: [{ id: "12:35", courseId: "12" }],
  });
  ui = await mount(<PlaybackPanel />);
  expect(ui.host.textContent).toContain("재생목록이 멈췄습니다");
  await click("자동 재생 재개");
  expect(command).toHaveBeenCalledWith({
    version: 1,
    type: "PLAYBACK_RESUME",
  });
});

it("requires confirmation before deleting local playback data", async () => {
  setup();
  ui = await mount(<PlaybackPanel />);
  await click("로컬 데이터 모두 삭제");
  expect(ui.host.textContent).toContain(
    "저장된 재생목록과 상태를 모두 삭제합니다",
  );
  await click("삭제 확인");
  expect(command).toHaveBeenCalledWith({
    version: 1,
    type: "LOCAL_DATA_DELETE_ALL",
  });
});

it("refreshes the visible playlist after a background playback transition", async () => {
  const listeners = new Set<
    (message: unknown, sender: chrome.runtime.MessageSender) => void
  >();
  vi.stubGlobal("chrome", {
    runtime: {
      id: "extension-test",
      getURL: (path: string) => `chrome-extension://extension-test/${path}`,
      onMessage: {
        addListener: (
          listener: (
            message: unknown,
            sender: chrome.runtime.MessageSender,
          ) => void,
        ) => listeners.add(listener),
        removeListener: (
          listener: (
            message: unknown,
            sender: chrome.runtime.MessageSender,
          ) => void,
        ) => listeners.delete(listener),
      },
    },
  });
  setup();
  ui = await mount(<PlaybackPanel />);
  expect(command.mock.calls.map(([request]) => request.type)).toEqual([
    "PLAYBACK_STATUS",
    "PLAYBACK_REFRESH",
  ]);
  await act(async () => {
    for (const listener of listeners)
      listener(
        { version: 1, type: "PLAYBACK_UPDATED" },
        {
          id: "extension-test",
          url: "chrome-extension://extension-test/background.js",
        },
      );
  });
  expect(command.mock.calls.map(([request]) => request.type)).toEqual([
    "PLAYBACK_STATUS",
    "PLAYBACK_REFRESH",
    "PLAYBACK_STATUS",
  ]);
});

it("disables selection without a canonical item handle", async () => {
  setup();
  query.mockResolvedValue({
    status: "success",
    recordings: [
      {
        title: "module-only",
        module: "1주",
        lmsHandle: "00000000-0000-4000-8000-000000000001",
        launchHandle: "",
        type: "ExternalTool",
      },
    ],
  });
  ui = await mount(<PlaybackPanel />);
  await click("영상 선택");
  const select = ui.host.querySelector("select")!;
  await act(async () => {
    select.value = "12";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await click("영상 불러오기");
  expect(
    ui.host.querySelector<HTMLInputElement>(
      '.playback-choice input[type="checkbox"]',
    )?.disabled,
  ).toBe(true);
  expect(ui.host.textContent).toContain("자동 재생할 수 없습니다");
});

it("reports discovery failure without creating a playlist", async () => {
  setup();
  query.mockResolvedValue({ status: "error", code: "NETWORK" });
  ui = await mount(<PlaybackPanel />);
  await click("영상 선택");
  const select = ui.host.querySelector("select")!;
  await act(async () => {
    select.value = "12";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await click("영상 불러오기");
  expect(ui.host.querySelector('[role="alert"]')).not.toBeNull();
  expect(command.mock.calls.map(([request]) => request.type)).not.toContain(
    "PLAYBACK_START",
  );
});

it("shows a static error when a playback command fails", async () => {
  command.mockResolvedValue({ status: "error", code: "NETWORK" });
  ui = await mount(<PlaybackPanel />);
  expect(ui.host.textContent).toContain("재생 요청 실패 (NETWORK)");
  expect(ui.host.querySelector('[role="alert"]')).not.toBeNull();
});
