// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { ResultList } from "../entrypoints/sidepanel/ResultList";
import { mount, click } from "./ui-helpers";
let ui: Awaited<ReturnType<typeof mount>>;
afterEach(async () => {
  await ui?.unmount();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("resets pagination on filter changes, preserves it on ticks, and expires candidates", async () => {
  vi.useFakeTimers();
  const now = Date.parse("2026-09-12T00:00:00Z");
  vi.setSystemTime(now);
  const deadlines = Array.from({ length: 105 }, (_, i) => ({
    title: `과제 ${i}`,
    due_at: new Date(now + 60000).toISOString(),
    remaining_candidate: true,
  }));
  ui = await mount(
    <ResultList
      result={{ status: "success", deadlines }}
      onCourse={() => {}}
    />,
  );
  expect(
    (document.querySelector('input[type="checkbox"]') as HTMLInputElement)
      .checked,
  ).toBe(true);
  await click("다음");
  await act(async () => {
    vi.advanceTimersByTime(1000);
  });
  expect(document.body.textContent).toContain("101–105 / 105개");
  await act(async () => {
    (
      document.querySelector('input[type="checkbox"]') as HTMLInputElement
    ).click();
  });
  expect(document.body.textContent).toContain("1–100 / 105개");
  await act(async () => {
    (
      document.querySelector('input[type="checkbox"]') as HTMLInputElement
    ).click();
  });
  await act(async () => {
    vi.advanceTimersByTime(59000);
  });
  expect(document.body.textContent).toContain("조건에 맞는 과제가 없습니다.");
  expect(document.querySelectorAll("li")).toHaveLength(0);
});
it("sorts the whole response before pagination and returns to LMS order", async () => {
  const deadlines = Array.from({ length: 105 }, (_, i) => ({
    title: `과제 ${i}`,
    due_at: new Date(Date.UTC(2027, 0, 1) - i * 60000).toISOString(),
    remaining_candidate: false,
  }));
  ui = await mount(
    <ResultList
      result={{ status: "success", deadlines }}
      onCourse={() => {}}
    />,
  );
  expect(document.querySelectorAll("li")).toHaveLength(0);
  await act(async () => {
    (
      document.querySelector('input[type="checkbox"]') as HTMLInputElement
    ).click();
  });
  expect(document.querySelectorAll("li")).toHaveLength(100);
  const select = document.querySelectorAll("select")[1]!;
  await act(async () => {
    select.value = "due";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(document.querySelector("li strong")?.textContent).toBe("과제 104");
  await act(async () => {
    select.value = "original";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(document.querySelector("li strong")?.textContent).toBe("과제 0");
});
