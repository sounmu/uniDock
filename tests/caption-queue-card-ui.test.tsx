// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { mount } from "./ui-helpers";
import type { QueueItem } from "../entrypoints/sidepanel/useCaptionQueue";

const useCaptionAccount = vi.hoisted(() =>
  vi.fn<(session: unknown, revision: unknown) => null>(() => null),
);
let items: QueueItem[] = [];
let running = false;
vi.mock("../entrypoints/sidepanel/useCaptionQueue", () => ({
  useCaptionQueue: () => ({ items, running, start: vi.fn(), clear: vi.fn(), stop: vi.fn() }),
}));
vi.mock("../entrypoints/sidepanel/useCaptionSession", () => ({
  useCaptionSession: () => ({ email: "student@example.com", loginId: "login-a" }),
}));
vi.mock("../entrypoints/sidepanel/useCaptionAccount", async (original) => ({
  ...(await original<object>()),
  useCaptionAccount,
}));
vi.mock("../entrypoints/sidepanel/useRecordingPicker", () => ({
  useRecordingPicker: () => ({ recordings: [], loadCourses: vi.fn(), takeSelection: vi.fn() }),
}));

let ui: Awaited<ReturnType<typeof mount>>;
afterEach(async () => {
  await ui?.unmount();
  vi.clearAllMocks();
});

const item = (phase: QueueItem["phase"]): QueueItem => ({
  handle: "a",
  title: "강의",
  phase,
  progress: null,
  errorCode: null,
  jobId: "job-a",
});
const revision = () => useCaptionAccount.mock.calls.at(-1)?.[1];

it("reads today's uses again when a cancelled job gives its use back", async () => {
  const { CaptionQueue } = await import("../entrypoints/sidepanel/CaptionQueue");
  const card = () => <CaptionQueue picking={false} onPick={() => {}} onBack={() => {}} />;
  items = [item("extracting")];
  running = true;
  ui = await mount(card());
  const holding = revision();
  items = [item("cancelled")];
  running = false;
  await ui.render(card());
  expect(revision()).not.toEqual(holding);
});
