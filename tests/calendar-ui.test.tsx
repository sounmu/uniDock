// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { mount, click } from "./ui-helpers";
import type { CalendarEvent } from "../src/calendar/events";
const query = vi.hoisted(() => vi.fn());
const command = vi.hoisted(() => vi.fn());
vi.mock("../src/transport", () => ({ queryActive: query }));
vi.mock("../src/playback/bridge", () => ({ playbackCommand: command }));
vi.mock("../entrypoints/sidepanel/CaptionsPanel", () => ({
  CaptionsPanel: () => <p>자막</p>,
}));
import { App } from "../entrypoints/sidepanel/App";
import {
  CalendarPanel,
  monthRange,
  navigateMonth,
} from "../entrypoints/sidepanel/CalendarPanel";
const event = {
  id: "announcement:abcdef12",
  course: "역사",
  title: "발표",
  action: "발표",
  target: "조별",
  date: "2026-09-25",
  kind: "announcement" as const,
  status: ["ambiguous", "conflict"] as const,
  evidence: "발표 2026-09-25",
  sourceRevision: "2026-09-01T00:00:00Z",
};
let ui: Awaited<ReturnType<typeof mount>>;
let overrides: object[];
afterEach(async () => {
  await ui?.unmount();
  vi.resetAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function setup() {
  overrides = [];
  query.mockResolvedValue({ status: "success", calendar: [event] });
  command.mockImplementation(async (request) => {
    if (request.type === "CALENDAR_OVERRIDE_SET")
      overrides = [request.override];
    if (request.type === "CALENDAR_OVERRIDE_REMOVE") overrides = [];
    return {
      status: "success",
      snapshot: {
        calendarOverrides: overrides.map((item) => ({
          ...item,
          confirmationRequired: false,
        })),
      },
    };
  });
}
async function input(label: string, value: string) {
  const field = [...document.querySelectorAll("label")]
    .find((node) => node.textContent?.includes(label))
    ?.querySelector("input");
  expect(field).toBeDefined();
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
function calendarEvent(changes: Partial<CalendarEvent> = {}): CalendarEvent {
  return { ...event, status: [...event.status], ...changes };
}
async function panel(
  events: CalendarEvent[],
  props: {
    loading?: boolean;
    errorCode?: "LOGIN_REQUIRED";
    postingStart?: string;
    postingEnd?: string;
  } = {},
) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-15T00:00:00Z"));
  setup();
  const onLoadMonth = vi.fn();
  const onPostingChange = vi.fn();
  ui = await mount(
    <CalendarPanel
      events={events}
      loading={props.loading ?? false}
      errorCode={props.errorCode}
      postingStart={props.postingStart ?? "2026-09-01"}
      postingEnd={props.postingEnd ?? "2026-09-30"}
      onLoadMonth={onLoadMonth}
      onPostingChange={onPostingChange}
    />,
  );
  return { onLoadMonth, onPostingChange };
}
function card(title: string): HTMLElement {
  const result = [...ui.host.querySelectorAll<HTMLElement>(".event-card")].find(
    (node) => node.querySelector("strong")?.textContent === title,
  );
  expect(result).toBeDefined();
  return result!;
}
async function chooseCourse(value: string) {
  const select = ui.host.querySelector<HTMLSelectElement>(
    ".calendar-filters select",
  )!;
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
async function day(date: string) {
  const cells = [...ui.host.querySelectorAll<HTMLButtonElement>(".day-cell")];
  const cell = cells.find(
    (node) =>
      !node.classList.contains("out-of-month") &&
      node.querySelector(".day-number")?.textContent ===
        String(Number(date.slice(8))),
  );
  expect(cell).toBeDefined();
  await act(async () => cell!.click());
  return cell!;
}

it("requests a displayed month separately from announcement posting dates and shows sourced evidence", async () => {
  setup();
  ui = await mount(<App />);
  await click("전체 일정");
  const first = query.mock.calls[0]![0];
  expect(first).toEqual({
    version: 1,
    type: "CALENDAR_LIST",
    month: first.month,
    start_date: monthRange(first.month).start,
    end_date: monthRange(first.month).end,
  });
  await click("목록");
  expect(ui.host.textContent).toContain("근거: 발표 2026-09-25");
  expect(ui.host.textContent).toContain("일정 충돌");
  expect(ui.host.textContent).toContain("확인 필요");
  await input("공지 게시 시작일", "2026-08-01");
  await act(async () =>
    ui.host.querySelector<HTMLButtonElement>('[aria-label="다음 달"]')!.click(),
  );
  expect(query.mock.lastCall![0]).toEqual({
    version: 1,
    type: "CALENDAR_LIST",
    month: navigateMonth(first.month, 1),
    start_date: "2026-08-01",
    end_date: first.end_date,
  });
});
it("persists an exclusion and restores it via the background contract", async () => {
  setup();
  ui = await mount(<App />);
  await click("전체 일정");
  await click("목록");
  await click("제외");
  expect(command).toHaveBeenCalledWith({
    version: 1,
    type: "CALENDAR_OVERRIDE_SET",
    override: {
      id: event.id,
      sourceRevision: event.sourceRevision,
      excluded: true,
    },
  });
  expect(ui.host.textContent).toContain("제외된 항목 (1건)");
  await click("복원");
  expect(command).toHaveBeenCalledWith({
    version: 1,
    type: "CALENDAR_OVERRIDE_REMOVE",
    id: event.id,
  });
  expect(ui.host.textContent).toContain("근거: 발표 2026-09-25");
});

it("shows changed, cancelled, conflicting, and undated status on the corresponding events", async () => {
  await panel([
    calendarEvent({
      status: ["changed", "conflict"],
      sourceUrl: "https://mylms.korea.ac.kr/courses/1",
    }),
    calendarEvent({
      id: "announcement:abcdef13",
      title: "취소",
      status: ["cancelled", "date-only"],
    }),
    calendarEvent({
      id: "announcement:abcdef14",
      title: "미정",
      date: undefined,
      status: ["ambiguous"],
    }),
  ]);
  expect(
    ui.host.querySelector(".undated-events .event-card strong")?.textContent,
  ).toBe("미정");
  expect(ui.host.querySelector(".undated-events h4")?.textContent).toContain(
    "(1건)",
  );
  await click("목록");
  expect(card("발표").querySelector(".status-changed")).not.toBeNull();
  expect(card("발표").querySelector(".status-conflict")).not.toBeNull();
  expect(card("발표").querySelector<HTMLAnchorElement>("a")?.href).toBe(
    "https://mylms.korea.ac.kr/courses/1",
  );
  expect(card("취소").querySelector(".status-cancelled")).not.toBeNull();
  expect(
    [...ui.host.querySelectorAll(".calendar-list .event-card strong")].map(
      (node) => node.textContent,
    ),
  ).toEqual(["발표", "취소", "미정"]);
});

it("requires reconfirmation for a source revision change before applying an old correction", async () => {
  await panel([
    calendarEvent({
      date: "2026-09-25",
      sourceRevision: "2026-09-02T00:00:00Z",
    }),
  ]);
  command.mockImplementation(async (request) => ({
    status: "success",
    snapshot: {
      calendarOverrides:
        request.type === "CALENDAR_OVERRIDE_SET"
          ? [{ ...request.override, confirmationRequired: false }]
          : [
              {
                id: event.id,
                sourceRevision: event.sourceRevision,
                excluded: false,
                date: "2026-09-20",
                time: "10:00",
                confirmationRequired: true,
              },
            ],
    },
  }));
  // The GET effect runs on an event change with the new source revision.
  await ui.render(
    <CalendarPanel
      events={[calendarEvent({ sourceRevision: "2026-09-02T00:00:00Z" })]}
      loading={false}
      postingStart="2026-09-01"
      postingEnd="2026-09-30"
      onPostingChange={vi.fn()}
      onLoadMonth={vi.fn()}
    />,
  );
  await click("목록");
  expect(card("발표").querySelector(".status-ambiguous")).not.toBeNull();
  expect(card("발표").textContent).toContain("2026-09-25");
  expect(card("발표").textContent).not.toContain("2026-09-20");
  await click("수정");
  await input("날짜", "2026-09-21");
  await click("확인");
  expect(command).toHaveBeenCalledWith({
    version: 1,
    type: "CALENDAR_OVERRIDE_SET",
    override: {
      id: event.id,
      sourceRevision: "2026-09-02T00:00:00Z",
      excluded: false,
      date: "2026-09-21",
    },
  });
  expect(card("발표").textContent).toContain("2026-09-21");
  expect(card("발표").querySelector(".status-confirmed")).not.toBeNull();
  expect(card("발표").querySelector(".status-ambiguous")).toBeNull();
});

it("saves a date-only edit without inventing a time and can discard it", async () => {
  await panel([calendarEvent({ status: ["ambiguous", "date-only"] })]);
  await click("목록");
  await click("수정");
  await input("날짜", "2026-09-27");
  await click("확인");
  expect(command).toHaveBeenCalledWith({
    version: 1,
    type: "CALENDAR_OVERRIDE_SET",
    override: {
      id: event.id,
      sourceRevision: event.sourceRevision,
      excluded: false,
      date: "2026-09-27",
    },
  });
  expect(card("발표").querySelector(".status-confirmed")).not.toBeNull();
  expect(card("발표").querySelector(".status-date-only")).not.toBeNull();
  expect(card("발표").textContent).toContain("2026-09-27");
  await click("원래대로");
  expect(command).toHaveBeenCalledWith({
    version: 1,
    type: "CALENDAR_OVERRIDE_REMOVE",
    id: event.id,
  });
  expect(card("발표").querySelector(".status-ambiguous")).not.toBeNull();
});

it("filters courses and counts dense and empty selected days", async () => {
  await panel([
    calendarEvent(),
    calendarEvent({
      id: "announcement:abcdef13",
      title: "두번째",
      course: "역사",
    }),
    calendarEvent({
      id: "announcement:abcdef14",
      title: "다른 과목",
      course: "수학",
    }),
  ]);
  const dense = await day("2026-09-25");
  expect(dense.getAttribute("aria-pressed")).toBe("true");
  expect(dense.querySelector(".day-count")?.textContent).toBe("3");
  expect(ui.host.querySelectorAll(".day-details .event-card")).toHaveLength(3);
  await chooseCourse("역사");
  expect(dense.querySelector(".day-count")?.textContent).toBe("2");
  expect(ui.host.querySelectorAll(".day-details .event-card")).toHaveLength(2);
  await day("2026-09-24");
  expect(ui.host.querySelectorAll(".day-details .event-card")).toHaveLength(0);
  await chooseCourse("수학");
  await click("목록");
  expect(
    [...ui.host.querySelectorAll(".calendar-list .event-card strong")].map(
      (node) => node.textContent,
    ),
  ).toEqual(["다른 과목"]);
  expect(ui.host.querySelector(".count")?.textContent).toContain(
    "3개 일정 중 1개 표시",
  );
});

it("shows query errors and prevents refresh for an invalid posting range or loading state", async () => {
  const { onLoadMonth, onPostingChange } = await panel([], {
    errorCode: "LOGIN_REQUIRED",
    postingStart: "2026-09-30",
    postingEnd: "2026-09-01",
  });
  expect(ui.host.querySelector(".notice.error strong")?.textContent).toBe(
    "로그인 필요",
  );
  expect(ui.host.querySelector(".filter-error")).not.toBeNull();
  expect(
    ui.host.querySelector<HTMLButtonElement>(
      ".calendar-panel > button.secondary",
    )?.disabled,
  ).toBe(true);
  expect(onLoadMonth).toHaveBeenCalledTimes(1);
  await input("공지 게시 시작일", "2026-09-01");
  expect(onPostingChange).toHaveBeenCalledWith("start", "2026-09-01");
  await ui.render(
    <CalendarPanel
      events={[]}
      loading={true}
      postingStart="2026-09-01"
      postingEnd="2026-09-30"
      onPostingChange={onPostingChange}
      onLoadMonth={onLoadMonth}
    />,
  );
  expect(
    ui.host.querySelector('[aria-live="polite"]')?.getAttribute("aria-busy"),
  ).toBe("true");
  expect(ui.host.querySelector(".calendar-grid")).toBeNull();
  expect(
    ui.host.querySelector<HTMLButtonElement>(
      ".calendar-panel > button.secondary",
    )?.disabled,
  ).toBe(true);
});

it("keeps month and day controls focusable and navigates across month boundaries", async () => {
  const { onLoadMonth } = await panel([calendarEvent({ date: "2026-09-25" })]);
  const next = ui.host.querySelector<HTMLButtonElement>(
    '[aria-label="다음 달"]',
  )!;
  next.focus();
  expect(document.activeElement).toBe(next);
  await act(async () => next.click());
  expect(onLoadMonth).toHaveBeenLastCalledWith("2026-10");
  expect(
    ui.host.querySelector('[role="grid"]')?.getAttribute("aria-label"),
  ).toBe("2026년 10월");
  const previous = ui.host.querySelector<HTMLButtonElement>(
    '[aria-label="이전 달"]',
  )!;
  await act(async () => previous.click());
  expect(onLoadMonth).toHaveBeenLastCalledWith("2026-09");
  const selected = await day("2026-09-25");
  selected.focus();
  expect(document.activeElement).toBe(selected);
  expect(selected.getAttribute("aria-pressed")).toBe("true");
  expect(ui.host.querySelectorAll(".day-details .event-card")).toHaveLength(1);
  await act(async () => selected.click());
  expect(selected.getAttribute("aria-pressed")).toBe("false");
  expect(ui.host.querySelector(".day-details")).toBeNull();
});

it("refreshes playback markers when the background announces an update", async () => {
  let notify:
    | ((message: unknown, sender: chrome.runtime.MessageSender) => void)
    | undefined;
  vi.stubGlobal("chrome", {
    runtime: {
      id: "extension-test",
      getURL: (path: string) => `chrome-extension://extension-test/${path}`,
      onMessage: {
        addListener: vi.fn((listener) => {
          notify = listener;
        }),
        removeListener: vi.fn(),
      },
    },
  });
  let queue: object[] = [];
  command.mockImplementation(async () => ({
    status: "success",
    snapshot: {
      calendarOverrides: [],
      courses: [{ id: "101", name: "역사" }],
      labels: { "101:501": "영상" },
      queue,
      active: null,
    },
  }));
  ui = await mount(
    <CalendarPanel
      events={[]}
      loading={false}
      postingStart="2026-09-01"
      postingEnd="2026-09-30"
      onPostingChange={vi.fn()}
      onLoadMonth={vi.fn()}
    />,
  );
  await click("목록");
  expect(
    ui.host.querySelectorAll("[data-playback-kind='reservation']"),
  ).toHaveLength(0);
  expect(notify).toBeDefined();
  queue = [
    {
      id: "101:501",
      courseId: "101",
      startAt: Date.parse("2026-10-06T09:00:00+09:00"),
      deadline: Date.parse("2026-10-07T18:00:00+09:00"),
    },
  ];
  await act(async () =>
    notify!({ version: 1, type: "PLAYBACK_UPDATED" }, { id: "extension-test" }),
  );
  expect(
    ui.host.querySelectorAll("[data-playback-kind='reservation']"),
  ).toHaveLength(1);
  expect(
    ui.host.querySelectorAll("[data-playback-kind='viewing-deadline']"),
  ).toHaveLength(1);
  expect(
    command.mock.calls.filter(
      ([request]) => request.type === "PLAYBACK_STATUS",
    ),
  ).toHaveLength(2);
  expect(command).toHaveBeenCalledWith({ version: 1, type: "PLAYBACK_STATUS" });
  expect(command).toHaveBeenCalledWith({
    version: 1,
    type: "CALENDAR_OVERRIDES_GET",
    sources: [],
  });
});

it("marks a confirmed viewing deadline separately from its scheduled playback time", async () => {
  query.mockResolvedValue({ status: "success", calendar: [] });
  command.mockResolvedValue({
    status: "success",
    snapshot: {
      calendarOverrides: [],
      courses: [{ id: "101", name: "역사" }],
      labels: { "101:501": "1주차 합성 영상" },
      queue: [
        {
          id: "101:501",
          courseId: "101",
          startAt: Date.parse("2026-10-06T09:00:00+09:00"),
          finishAt: Date.parse("2026-10-06T09:01:00+09:00"),
          deadline: Date.parse("2026-10-07T18:00:00+09:00"),
          margin: "full",
        },
      ],
      active: null,
    },
  });
  ui = await mount(<App />);
  await click("전체 일정");
  await click("목록");
  const reservation = ui.host.querySelector(
    '.event-card:has([data-playback-kind="reservation"])',
  );
  const deadline = ui.host.querySelector(
    '.event-card:has([data-playback-kind="viewing-deadline"])',
  );
  expect(reservation?.textContent).toContain("2026-10-06 09:00");
  expect(deadline?.textContent).toContain("2026-10-07 18:00");
  expect(reservation?.querySelector("button")).toBeNull();
  expect(deadline?.querySelector("button")).toBeNull();
  expect(command).toHaveBeenCalledWith({
    version: 1,
    type: "PLAYBACK_STATUS",
  });
});

it("keeps both calendar markers for the active video when no job remains queued", async () => {
  query.mockResolvedValue({ status: "success", calendar: [] });
  command.mockResolvedValue({
    status: "success",
    snapshot: {
      calendarOverrides: [],
      courses: [],
      labels: {},
      queue: [],
      active: {
        id: "101:501",
        courseId: "101",
        startAt: Date.parse("2026-10-06T09:00:00+09:00"),
        deadline: Date.parse("2026-10-07T18:00:00+09:00"),
        credit: "unknown",
      },
    },
  });
  ui = await mount(<App />);
  await click("전체 일정");
  await click("목록");
  expect(
    ui.host.querySelectorAll("[data-playback-kind='reservation']"),
  ).toHaveLength(1);
  expect(
    ui.host.querySelectorAll("[data-playback-kind='viewing-deadline']"),
  ).toHaveLength(1);
  expect(ui.host.querySelectorAll(".calendar-list .event-card")).toHaveLength(
    2,
  );
});

it("keeps the structured calendar usable when playback status is unavailable", async () => {
  query.mockResolvedValue({ status: "success", calendar: [event] });
  command.mockImplementation(async (request) =>
    request.type === "PLAYBACK_STATUS"
      ? { status: "error", code: "OPEN_LMS" }
      : { status: "success", snapshot: { calendarOverrides: [] } },
  );
  ui = await mount(<App />);
  await click("전체 일정");
  await click("목록");
  expect(ui.host.querySelectorAll(".calendar-list .event-card")).toHaveLength(
    1,
  );
  expect(ui.host.querySelectorAll("[data-playback-kind]")).toHaveLength(0);
});

it("retains an unmatched prior correction for explicit review after the source changes", async () => {
  query.mockResolvedValue({ status: "success", calendar: [] });
  const prior = {
    id: event.id,
    sourceRevision: event.sourceRevision,
    excluded: true,
    confirmationRequired: true,
  };
  command.mockImplementation(async (request) => ({
    status: "success",
    snapshot: {
      calendarOverrides:
        request.type === "CALENDAR_OVERRIDE_REMOVE" ? [] : [prior],
    },
  }));
  ui = await mount(<App />);
  await click("전체 일정");
  expect(command).toHaveBeenCalledWith({
    version: 1,
    type: "CALENDAR_OVERRIDES_GET",
    sources: [],
  });
  expect(ui.host.querySelectorAll('[role="status"] li')).toHaveLength(1);
  await click("이전 설정 삭제");
  expect(command).toHaveBeenCalledWith({
    version: 1,
    type: "CALENDAR_OVERRIDE_REMOVE",
    id: event.id,
  });
  expect(ui.host.querySelectorAll('[role="status"] li')).toHaveLength(0);
});
