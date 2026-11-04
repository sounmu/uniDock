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

it("renders five tabs with 설정 last, wired to onInfo", async () => {
  const onInfo = vi.fn();
  ui = await mount(
    <Rail
      section="courses"
      onSelect={() => {}}
      onInfo={onInfo}
      playbackAvailable
    />,
  );
  const buttons = [...document.querySelectorAll<HTMLButtonElement>("nav button")];
  expect(buttons.map((button) => button.textContent)).toEqual([
    "내 과목",
    "할 일·일정",
    "자동 재생",
    "자막 추출",
    "설정",
  ]);
  const settings = buttons[4]!;
  expect(settings.hasAttribute("aria-current")).toBe(false);
  await act(async () => settings.click());
  expect(onInfo).toHaveBeenCalledTimes(1);
  await ui.unmount();
  ui = await mount(
    <Rail
      section="courses"
      onSelect={() => {}}
      onInfo={onInfo}
      playbackAvailable
      info
    />,
  );
  const open = [...document.querySelectorAll<HTMLButtonElement>("nav button")];
  expect(open[4]!.getAttribute("aria-current")).toBe("page");
  expect(open[0]!.hasAttribute("aria-current")).toBe(false);
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
