// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { mount, click } from "./ui-helpers";
const command = vi.hoisted(() => vi.fn());
const query = vi.hoisted(() => vi.fn());
vi.mock("../src/playback/bridge", () => ({ playbackCommand: command }));
vi.mock("../src/transport", () => ({ queryActive: query }));
import { PlaybackPanel } from "../entrypoints/sidepanel/PlaybackPanel";
let ui: Awaited<ReturnType<typeof mount>>;
afterEach(async () => {
  await ui?.unmount();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});
const settings = {
  enabled: false,
  courseIds: [],
  windowStartHour: 9,
  windowEndHour: 22,
  leadHours: 24,
  marginMinutes: 5,
};
const snapshot = {
  settings,
  courses: [{ id: "12", name: "역사" }],
  labels: { "12:34": "운영체제 1강", "12:35": "운영체제 2강" },
  queue: [
    {
      id: "12:34",
      courseId: "12",
      startAt: 1000000000000,
      finishAt: 1000000001000,
      deadline: 1000000010000,
      margin: "full",
    },
  ],
  blocked: [
    {
      id: "12:35",
      courseId: "12",
      reason: "unknown_duration",
      requiresManualConfirmation: true,
    },
  ],
  status: "scheduled",
  active: null,
  finishedIds: [],
  confirmationRequired: true,
  calendarOverrides: [],
};
function setup() {
  let current = snapshot;
  command.mockImplementation(async (request) => {
    if (request.type === "PLAYBACK_CONFIGURE")
      current = { ...current, settings: request.settings };
    return { status: "success", snapshot: current };
  });
}
it("starts off, exposes queue and distinct LMS credit, and sends settings and controls", async () => {
  setup();
  ui = await mount(<PlaybackPanel />);
  expect(command).toHaveBeenCalledWith({ version: 1, type: "PLAYBACK_STATUS" });
  expect(ui.host.textContent).toContain("다음: 운영체제 1강");
  expect(ui.host.textContent).not.toContain("12:34");
  expect(ui.host.textContent).toContain("영상 길이 확인 필요");
  const checkbox = ui.host.querySelector<HTMLInputElement>(
    'input[type="checkbox"]',
  )!;
  expect(checkbox.checked).toBe(false);
  await act(async () => checkbox.click());
  expect(command).toHaveBeenCalledWith({
    version: 1,
    type: "PLAYBACK_CONFIGURE",
    settings: { ...settings, enabled: true },
  });
  await click("예약 취소");
  expect(command).toHaveBeenCalledWith({
    version: 1,
    type: "PLAYBACK_CANCEL",
    id: "12:34",
  });
  await click("일시정지");
  await click("재개");
  await click("전체 중지");
  expect(command.mock.calls.map((call) => call[0].type)).toEqual(
    expect.arrayContaining([
      "PLAYBACK_PAUSE",
      "PLAYBACK_RESUME",
      "PLAYBACK_STOP_ALL",
    ]),
  );
  await click("로컬 데이터 모두 삭제");
  expect(command.mock.calls.map((call) => call[0].type)).not.toContain(
    "LOCAL_DATA_DELETE_ALL",
  );
  await click("삭제 확인");
  expect(command).toHaveBeenCalledWith({
    version: 1,
    type: "LOCAL_DATA_DELETE_ALL",
  });
});
it("confirms video metadata only after selecting a real LMS recording handle", async () => {
  setup();
  command.mockResolvedValue({
    status: "success",
    snapshot: { ...snapshot, settings: { ...settings, enabled: true } },
  });
  const handle = "00000000-0000-4000-8000-000000000001";
  query.mockResolvedValue({
    status: "success",
    recordings: [
      {
        title: "강의",
        module: "1주",
        lmsHandle: "module-handle",
        launchHandle: handle,
        type: "ExternalTool",
      },
    ],
  });
  ui = await mount(<PlaybackPanel />);
  const select = ui.host.querySelector("select")!;
  await act(async () => {
    select.value = "역사";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await click("녹화 후보 조회");
  await click("정보 확인");
  expect(command.mock.calls.map((call) => call[0].type)).not.toContain(
    "PLAYBACK_CONFIRM",
  );
  const dateField = ui.host.querySelector<HTMLInputElement>(
    'input[type="datetime-local"]',
  )!;
  const durationField = [
    ...ui.host.querySelectorAll<HTMLInputElement>('input[type="number"]'),
  ].at(-1)!;
  for (const [field, value] of [
    [dateField, "2026-10-01T12:00"],
    [durationField, "45"],
  ] as const) {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(field, value);
      field!.dispatchEvent(new Event("input", { bubbles: true }));
      field!.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }
  expect(dateField.value).toBe("2026-10-01T12:00");
  expect(durationField.value).toBe("45");
  expect(
    [...ui.host.querySelectorAll("button")].find(
      (button) => button.textContent === "LMS 미이수 확인 후 예약",
    )?.disabled,
  ).toBe(false);
  await click("LMS 미이수 확인 후 예약");
  expect(command).toHaveBeenCalledWith({
    version: 1,
    type: "PLAYBACK_CONFIRM",
    handle,
    deadline: "2026-10-01T03:00:00.000Z",
    durationMinutes: 45,
    completion: "incomplete",
  });
});

it("refreshes the visible queue when the background reports a playback transition", async () => {
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
  expect(command).toHaveBeenCalledTimes(1);
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
  expect(command).toHaveBeenCalledTimes(2);
  await ui.unmount();
  expect(listeners.size).toBe(0);
});

it("leaves opt-in unavailable when account discovery fails", async () => {
  command.mockResolvedValue({ status: "error", code: "OPEN_LMS" });
  ui = await mount(<PlaybackPanel />);
  expect(ui.host.querySelector('[role="alert"]')).not.toBeNull();
  expect(
    ui.host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.disabled,
  ).toBe(true);
  expect(query).not.toHaveBeenCalled();
});

it("cannot confirm a recording without its item handle, date, and length", async () => {
  command.mockResolvedValue({
    status: "success",
    snapshot: { ...snapshot, settings: { ...settings, enabled: true } },
  });
  query.mockResolvedValue({
    status: "success",
    recordings: [
      {
        title: "module-only",
        module: "1주",
        lmsHandle: "module-handle",
        launchHandle: "",
        type: "ExternalTool",
      },
      {
        title: "item-backed",
        module: "1주",
        lmsHandle: "other-module-handle",
        launchHandle: "00000000-0000-4000-8000-000000000001",
        type: "ExternalTool",
      },
    ],
  });
  ui = await mount(<PlaybackPanel />);
  const select = ui.host.querySelector("select")!;
  await act(async () => {
    select.value = "역사";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await click("녹화 후보 조회");
  const choices = [...ui.host.querySelectorAll("button")].filter(
    (button) => button.textContent === "정보 확인",
  );
  expect(choices.map(({ disabled }) => disabled)).toEqual([true, false]);
  await act(async () => choices[1]!.click());
  const confirm = [...ui.host.querySelectorAll("button")].find(
    (button) => button.textContent === "LMS 미이수 확인 후 예약",
  )!;
  expect(confirm.disabled).toBe(true);
  expect(command.mock.calls.map(([request]) => request.type)).not.toContain(
    "PLAYBACK_CONFIRM",
  );
});

it("reports a failed LMS recording list without offering a fabricated reservation", async () => {
  command.mockResolvedValue({
    status: "success",
    snapshot: { ...snapshot, settings: { ...settings, enabled: true } },
  });
  query.mockResolvedValue({ status: "error", code: "NETWORK" });
  ui = await mount(<PlaybackPanel />);
  const select = ui.host.querySelector("select")!;
  await act(async () => {
    select.value = "역사";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await click("녹화 후보 조회");
  expect(ui.host.querySelector('[role="alert"]')).not.toBeNull();
  expect(
    [...ui.host.querySelectorAll("button")].some(
      (button) => button.textContent === "정보 확인",
    ),
  ).toBe(false);
  expect(command.mock.calls.map(([request]) => request.type)).not.toContain(
    "PLAYBACK_CONFIRM",
  );
});
