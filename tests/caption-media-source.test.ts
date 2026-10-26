// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://kucom.korea.ac.kr/em/lecture"}
import { afterEach, expect, it, vi } from "vitest";
import { identifyMedia, readPlayerMedia } from "../src/captions/media-source";

const good =
  "https://korea-cms-object.cdn.gov-ntruss.com/contents7/kruniv1001/0123456789abc/contents/media_files/screen.mp4";

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as unknown as { uniPlayerConfig?: unknown }).uniPlayerConfig;
});

function setConfig(value: unknown) {
  (window as unknown as { uniPlayerConfig?: unknown }).uniPlayerConfig = value;
}

it("reads the first non-intro desktop media uri", () => {
  setConfig({
    _contentPlayingInfoData: {
      duration: 3960,
      storyList: [
        { isIntro: true, mainMediaList: { list: [{ desktopMediaUri: "x" }] } },
        { mainMediaList: { list: [{ desktopMediaUri: good }] } },
      ],
    },
  });
  expect(readPlayerMedia()).toEqual({
    mediaUrl: good,
    durationS: 3960,
    contentId: "0123456789abc",
  });
});

it("returns null without a config", () => {
  expect(readPlayerMedia()).toBeNull();
});

it("ignores a non-matching media uri", () => {
  setConfig({
    _contentPlayingInfoData: {
      storyList: [
        { mainMediaList: { list: [{ desktopMediaUri: "https://evil/x.mp4" }] } },
      ],
    },
  });
  expect(readPlayerMedia()).toBeNull();
});

it("answers only from the KU player document", () => {
  setConfig({
    _contentPlayingInfoData: {
      storyList: [{ mainMediaList: { list: [{ desktopMediaUri: good }] } }],
    },
  });
  window.history.replaceState(null, "", "/lecture");
  try {
    expect(readPlayerMedia()).toBeNull();
  } finally {
    window.history.replaceState(null, "", "/em/lecture");
  }
});

function stubTab(url: string) {
  const executeScript = vi.fn(async () => [
    { frameId: 0, documentId: "top", result: null },
    {
      frameId: 3,
      documentId: "player",
      result: { mediaUrl: good, durationS: 60, contentId: "0123456789abc" },
    },
  ]);
  vi.stubGlobal("chrome", {
    tabs: { query: vi.fn(async () => [{ id: 7, windowId: 1, url, title: "3주차 강의" }]) },
    scripting: { executeScript },
  });
  return executeScript;
}

it.each([
  "https://kucom.korea.ac.kr/em/lecture",
  "https://mylms.korea.ac.kr/courses/1/modules/items/2",
  "https://canvas.korea.ac.kr/courses/1/modules/items/2",
])("finds the player media from a %s tab", async (url) => {
  const executeScript = stubTab(url);
  await expect(identifyMedia()).resolves.toEqual({
    mediaUrl: good,
    durationS: 60,
    contentId: "0123456789abc",
    title: "3주차 강의",
    tabId: 7,
    windowId: 1,
  });
  expect(executeScript).toHaveBeenCalledWith(
    expect.objectContaining({ target: { tabId: 7, allFrames: true }, world: "MAIN" }),
  );
});

it("asks for the lecture tab on any other site", async () => {
  const executeScript = stubTab("https://example.com/em/lecture");
  await expect(identifyMedia()).rejects.toMatchObject({ code: "ACTIVATE_TAB" });
  expect(executeScript).not.toHaveBeenCalled();
});
