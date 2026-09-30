// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { mount } from "./ui-helpers";
import { PENDING_FEATURE_NOTICE, Rail } from "../entrypoints/sidepanel/ui/Rail";
let ui: Awaited<ReturnType<typeof mount>>;
afterEach(async () => {
  await ui?.unmount();
});
const menu = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("nav button")].find(
    (button) => button.textContent === label,
  );

it("keeps the playback entry as a focusable pending notice when unavailable", async () => {
  const onSelect = vi.fn();
  ui = await mount(
    <Rail
      section="courses"
      onSelect={onSelect}
      onInfo={() => {}}
      playbackAvailable={false}
    />,
  );
  const playback = menu("자동 재생")!;
  expect(playback).toBeDefined();
  expect(playback.disabled).toBe(false);
  expect(playback.getAttribute("aria-disabled")).toBe("true");
  expect(playback.hasAttribute("aria-current")).toBe(false);
  const notice = document.getElementById(
    playback.getAttribute("aria-describedby")!,
  );
  expect(notice?.getAttribute("role")).toBe("tooltip");
  expect(notice?.textContent).toBe(PENDING_FEATURE_NOTICE);
  // The notice is a sibling, so it never becomes part of the button's name.
  expect(playback.contains(notice)).toBe(false);

  await act(async () => playback.click());
  expect(onSelect).not.toHaveBeenCalled();

  await act(async () => menu("자막 추출")!.click());
  expect(onSelect).toHaveBeenCalledWith("captions");
});

it("selects playback normally when the build includes it", async () => {
  const onSelect = vi.fn();
  ui = await mount(
    <Rail
      section="playback"
      onSelect={onSelect}
      onInfo={() => {}}
      playbackAvailable
    />,
  );
  const playback = menu("자동 재생")!;
  expect(playback.hasAttribute("aria-disabled")).toBe(false);
  expect(playback.getAttribute("aria-current")).toBe("page");
  expect(document.querySelector("[role=tooltip]")).toBeNull();
  await act(async () => playback.click());
  expect(onSelect).toHaveBeenCalledWith("playback");
});
