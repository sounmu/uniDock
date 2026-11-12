// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { mount, click } from "./ui-helpers";
import { Rail } from "../entrypoints/sidepanel/ui/Rail";
let ui: Awaited<ReturnType<typeof mount>>;
afterEach(async () => { await ui?.unmount(); });

it("routes each top-level destination and marks only the active page", async () => {
  const onSelect = vi.fn();
  const onInfo = vi.fn();
  ui = await mount(<Rail section="home" onSelect={onSelect} onInfo={onInfo} />);
  expect(document.querySelectorAll("nav button")).toHaveLength(4);
  expect(document.querySelector('[aria-current="page"]')?.textContent).toBe("홈");
  await click("내 과목");
  expect(onSelect).toHaveBeenLastCalledWith("courses");
  await click("일정");
  expect(onSelect).toHaveBeenLastCalledWith("tasks");
  await click("홈");
  expect(onSelect).toHaveBeenLastCalledWith("home");
  await click("설정");
  expect(onInfo).toHaveBeenCalledOnce();
});

it("marks settings instead of the underlying screen while settings is open", async () => {
  ui = await mount(<Rail section="courses" onSelect={() => {}} onInfo={() => {}} info />);
  const current = document.querySelectorAll('[aria-current="page"]');
  expect(current).toHaveLength(1);
  expect(current[0]?.textContent).toBe("설정");
  const settings = current[0];
  await act(async () => { if (settings instanceof HTMLButtonElement) settings.focus(); });
  expect(document.activeElement).toBe(settings);
});
