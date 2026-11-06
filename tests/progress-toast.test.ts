// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ProgressItem } from "../src/progress";
import { createProgressToast } from "../src/progress-toast";

const caption = (phase: "queued" | "running" | "succeeded", percent: number | null = null): ProgressItem => ({
  kind: "captions",
  id: "job_1",
  phase,
  percent,
  workerOffline: false,
});
const root = () => document.getElementById("unidock-progress")?.shadowRoot ?? null;
const titles = () => [...(root()?.querySelectorAll("strong") ?? [])].map((n) => n.textContent);

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  document.getElementById("unidock-progress")?.remove();
});

it("updates one card in place as progress moves, without re-creating it", () => {
  const toast = createProgressToast();
  toast.update([caption("queued")]);
  const card = root()!.querySelector(".capsule");
  expect(titles()).toEqual(["AI 자막 대기 중"]);
  toast.update([caption("running", 40)]);
  expect(root()!.querySelector(".capsule")).toBe(card);
  expect(titles()).toEqual(["AI 자막 만드는 중"]);
  expect(root()!.querySelector(".end")!.textContent).toBe("40%");
  expect(root()!.querySelector("circle[stroke-dasharray]")!.getAttribute("stroke-dasharray")).toBe("23.88 59.69");
  expect(root()!.querySelector('[role="status"]')!.textContent).toBe("AI 자막 만드는 중");
});

it("announces completion only for work this page saw in progress, then hides it", () => {
  const toast = createProgressToast();
  toast.update([caption("succeeded")]);
  expect(root()).toBeNull();
  const other = createProgressToast();
  other.update([caption("running", 10)]);
  other.update([caption("succeeded")]);
  expect(titles()).toEqual(["AI 자막이 준비됐어요"]);
  vi.advanceTimersByTime(10_000);
  expect(root()).toBeNull();
});

it("keeps a closed card hidden until the work reaches its next stage", () => {
  const toast = createProgressToast();
  toast.update([caption("running", 10)]);
  (root()!.querySelector("button") as HTMLButtonElement).click();
  expect(root()).toBeNull();
  toast.update([caption("running", 20)]);
  expect(root()).toBeNull();
  toast.update([caption("succeeded")]);
  expect(titles()).toEqual(["AI 자막이 준비됐어요"]);
});

it("renders page-supplied titles as text", () => {
  const toast = createProgressToast();
  toast.update([
    { kind: "playback", id: "playback", status: "playing", title: "<img src=x onerror=alert(1)>", remaining: 0 },
  ]);
  expect(root()!.querySelector("img")).toBeNull();
  expect(root()!.querySelector(".detail")!.textContent).toBe("<img src=x onerror=alert(1)>");
});
