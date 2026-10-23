// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { readPlayerMedia } from "../src/captions/media-source";

const good =
  "https://korea-cms-object.cdn.gov-ntruss.com/contents7/kruniv1001/0123456789abc/contents/media_files/screen.mp4";

afterEach(() => {
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
