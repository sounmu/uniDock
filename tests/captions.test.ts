// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { collectCaptionSources } from "../src/captions/extract";
import { detectCaptions } from "../src/captions/service";
import { downloadCaption, exportTranscript } from "../src/captions/download";
import {
  formatTime,
  parseVtt,
  type Transcript,
} from "../src/captions/transcript";
const playerUrl = "https://kucom.korea.ac.kr/em/example";
const vtt =
  "WEBVTT\n\nintro\n00:00:36.000 --> 00:00:40.000\n안녕하십니까?\n이번 시간에는 국제법 주제에서\n\n00:00:40.123 --> 00:00:44.567 align:start\n국가에 버금가는 중요성을...\n";
const items = [
  {
    index: 0,
    time: "00:36",
    text: "안녕하십니까? 이번 시간에는 국제법 주제에서",
  },
  { index: 1, time: "00:40", text: "국가에 버금가는 중요성을..." },
];
const transcript: Transcript = {
  sourceUrl: "https://mylms.korea.ac.kr/courses/1/lecture",
  pageTitle: "국제법",
  extractedAt: "2026-09-12T06:00:00.000Z",
  itemCount: 2,
  items,
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.innerHTML = "";
  delete (window as unknown as Record<string, unknown>).uniPlayerConfig;
});
function player(caption: unknown = "list.xml") {
  vi.stubGlobal("location", new URL(playerUrl));
  const info = {
    contentType: "video1",
    contentUri: "https://kucom.korea.ac.kr/captions/",
    storyList: [
      { isIntro: true, storyFileNameList: { caption: "intro.xml" } },
      { storyFileNameList: { caption } },
    ],
    currStoryIdx: 0,
  };
  const config = {
    _contentPlayingInfoData: info,
    getContentPlayingInfoData: vi.fn(() => info),
    play: vi.fn(),
    setCurrentStoryPlayingInfo: vi.fn(),
  };
  Object.assign(window, { uniPlayerConfig: config });
  return config;
}
function responses(xml: string) {
  const fetcher = vi
    .fn()
    .mockImplementationOnce(async () => new Response(xml))
    .mockImplementationOnce(async () => new Response(vtt));
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
it("extracts direct DOM rows without Korean attributes and never fetches", async () => {
  document.body.innerHTML =
    '<ul id="cs-script-list"><li class="cs-script-item"><span class="cs-script-item-time">00:36</span><span class="cs-script-item-text">안녕하십니까?\n 이번 시간에는 국제법 주제에서</span></li><li class="cs-script-item"><span class="cs-script-item-time">00:40</span><span class="cs-script-item-text">국가에 버금가는 중요성을...</span></li><div><li class="cs-script-item"><span class="cs-script-item-text">제외</span></li></div></ul>';
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  const result = await collectCaptionSources("dom");
  expect(result.items).toEqual(items.map(({ time, text }) => ({ time, text })));
  expect(fetcher).not.toHaveBeenCalled();
});
it("does not silently export incomplete DOM rows", async () => {
  document.body.innerHTML =
    '<ul id="cs-script-list"><li class="cs-script-item"><span class="cs-script-item-text">시간 누락</span></li></ul>';
  expect(await collectCaptionSources("dom")).toMatchObject({
    items: [],
    blocked: true,
  });
});
it("reads selected story caption XML and prefers Korean over the first language", async () => {
  const config = player();
  const fetcher = responses(
    '<captions><caption lang="en" src="en.vtt"/><caption lang="ko" label="국문" src="ko.vtt"/></captions>',
  );
  const result = await collectCaptionSources("player");
  expect(result).toMatchObject({ vtt, label: "국문", blocked: false });
  expect(fetcher.mock.calls.map((call) => call[0])).toEqual([
    "https://kucom.korea.ac.kr/captions/list.xml",
    "https://kucom.korea.ac.kr/captions/ko.vtt",
  ]);
  expect(config.play).not.toHaveBeenCalled();
  expect(config.setCurrentStoryPlayingInfo).not.toHaveBeenCalled();
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
    method: "GET",
    credentials: "same-origin",
    redirect: "error",
  });
});
it("supports XML child fields, Korean labels, relative URLs and fallback language", async () => {
  player();
  const fetcher = responses(
    "<captions><item><name>English</name><url>en.vtt</url></item><item><name>Korean</name><url>../ko.vtt</url></item></captions>",
  );
  expect(await collectCaptionSources("player")).toMatchObject({
    label: "Korean",
    vtt,
  });
  expect(fetcher.mock.calls[1]?.[0]).toBe("https://kucom.korea.ac.kr/ko.vtt");
  responses('<captions><caption lang="en" src="en.vtt"/></captions>');
  expect(await collectCaptionSources("player")).toMatchObject({
    label: "en",
    vtt,
  });
});
it("does not send credentials to a declared external CDN", async () => {
  player();
  const fetcher = responses(
    '<captions><caption lang="ko" src="https://cdn.example.test/ko.vtt"/></captions>',
  );
  await collectCaptionSources("player");
  expect(fetcher.mock.calls[1]?.[1]).toMatchObject({
    credentials: "omit",
    referrerPolicy: "no-referrer",
  });
});
it.each([
  "<html>로그인</html>",
  "<captions><broken></captions>",
  '<!DOCTYPE captions [<!ENTITY x SYSTEM "file:///etc/passwd">]><captions/>',
])("rejects invalid XML %s", async (xml) => {
  player();
  const fetcher = responses(xml);
  expect(await collectCaptionSources("player")).toMatchObject({
    blocked: true,
    vtt: "",
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it.each([
  "http://kucom.korea.ac.kr/list.xml",
  "https://user:password@kucom.korea.ac.kr/list.xml",
  "/logout",
])("rejects non-caption or unsafe URL %s", async (caption) => {
  player(caption);
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  expect(await collectCaptionSources("player")).toMatchObject({
    blocked: true,
    vtt: "",
  });
  expect(fetcher).not.toHaveBeenCalled();
});
it("never invokes config accessors or reads unrelated frame players", async () => {
  vi.stubGlobal("location", new URL(playerUrl));
  const getter = vi.fn();
  Object.defineProperty(window, "uniPlayerConfig", {
    get: getter,
    configurable: true,
  });
  expect(await collectCaptionSources("player")).toMatchObject({ vtt: "" });
  expect(getter).not.toHaveBeenCalled();
  delete (window as unknown as Record<string, unknown>).uniPlayerConfig;
  const config = player();
  vi.stubGlobal("location", new URL("https://other.test/em/example"));
  await collectCaptionSources("player");
  expect(config.getContentPlayingInfoData).not.toHaveBeenCalled();
});
it("bounds oversized and failed fetches", async () => {
  player();
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        new Response(" ", { headers: { "content-length": "1000001" } }),
      ),
  );
  expect(await collectCaptionSources("player")).toMatchObject({
    blocked: true,
    vtt: "",
  });
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("CORS")));
  expect(await collectCaptionSources("player")).toMatchObject({
    blocked: true,
    vtt: "",
  });
});
it("preserves start time, joins cue lines and removes milliseconds", () =>
  expect(parseVtt(vtt)).toEqual(items));
it("preserves repeated cues, hour timestamps and decodes VTT markup", () => {
  expect(
    parseVtt(
      "WEBVTT\r\n\r\nNOTE note\r\nignore\r\n\r\nSTYLE\r\n::cue {}\r\n\r\n1\r\n01:02:03.444 --> 01:02:04.555\r\n<v Speaker><b>가</b> &amp; 나</v>\r\n\r\n2\r\n01:02:04.555 --> 01:02:05.555\r\n가 &amp; 나",
    ),
  ).toEqual([
    { index: 0, time: "01:02:03", text: "가 & 나" },
    { index: 1, time: "01:02:04", text: "가 & 나" },
  ]);
});
it.each([
  "garbage",
  "<html>login</html>",
  "WEBVTT\n\n00:99:01.000 --> 00:00:05.000\nbad",
])("rejects invalid VTT %s", (raw) => expect(() => parseVtt(raw)).toThrow());
it("exports exactly the requested JSON fields and readable TXT", () => {
  const result = exportTranscript({
    ...transcript,
    secret: "not exported",
  } as Transcript);
  expect(JSON.parse(result.json)).toEqual(transcript);
  expect(result.text).toBe(
    "00:36 안녕하십니까? 이번 시간에는 국제법 주제에서\n00:40 국가에 버금가는 중요성을...\n",
  );
  expect(formatTime("00:00:36.000")).toBe("00:36");
});
it("downloads both matching UTF-8 files under output/", async () => {
  vi.useFakeTimers();
  const download = vi.fn().mockResolvedValue(1);
  vi.stubGlobal("chrome", { downloads: { download } });
  const create = vi
      .fn()
      .mockReturnValueOnce("blob:txt")
      .mockReturnValueOnce("blob:json"),
    revoke = vi.fn();
  vi.stubGlobal(
    "URL",
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }),
  );
  await downloadCaption(transcript);
  expect(download.mock.calls.map((call) => call[0])).toEqual([
    {
      url: "blob:txt",
      filename: "output/uniDock-20260912T060000Z.txt",
      conflictAction: "uniquify",
      saveAs: false,
    },
    {
      url: "blob:json",
      filename: "output/uniDock-20260912T060000Z.json",
      conflictAction: "uniquify",
      saveAs: false,
    },
  ]);
  expect(create.mock.calls.map((call) => call[0].type)).toEqual([
    "text/plain;charset=utf-8",
    "application/json;charset=utf-8",
  ]);
  vi.advanceTimersByTime(60000);
  expect(revoke).toHaveBeenCalledTimes(2);
});
function injection(
  items: { time: string; text: string }[] = [],
  pageUrl = transcript.sourceUrl,
  documentId = "top",
  frameId = 0,
) {
  return {
    frameId,
    documentId,
    result: {
      items,
      vtt: "",
      label: "",
      source: "caption_script_dom",
      blocked: false,
      limited: false,
      pageUrl,
      pageTitle: "국제법",
    },
  };
}
function chromeMock(executeScript: ReturnType<typeof vi.fn>) {
  const query = vi
    .fn()
    .mockResolvedValue([
      { id: 7, url: transcript.sourceUrl, title: transcript.pageTitle },
    ]);
  const get = vi.fn().mockResolvedValue({ url: transcript.sourceUrl });
  vi.stubGlobal("chrome", {
    tabs: {
      query,
      get,
    },
    scripting: { executeScript },
  });
  return { get, query };
}
it("uses iframe DOM before any player fetch even when a KU player is available", async () => {
  const execute = vi
    .fn()
    .mockResolvedValueOnce([
      injection(),
      injection(items, playerUrl, "player", 1),
    ])
    .mockResolvedValueOnce([{ documentId: "top" }, { documentId: "player" }]);
  chromeMock(execute);
  const result = await detectCaptions();
  expect(result.status).toBe("success");
  if (result.status === "success")
    expect(result.captions[0]).toMatchObject({
      sourceUrl: transcript.sourceUrl,
      pageTitle: "국제법",
      items,
      itemCount: 2,
    });
  expect(execute).toHaveBeenCalledTimes(2);
  expect(execute.mock.calls[0]?.[0].target).toEqual({
    tabId: 7,
    allFrames: true,
  });
  expect(execute.mock.calls.some((call) => call[0].world === "MAIN")).toBe(
    false,
  );
});
it("falls back to the exact KU document only when every frame DOM is empty", async () => {
  const xmlResult = {
    ...injection([], playerUrl, "player", 1),
    result: { ...injection().result, source: "player_vtt", vtt, label: "국문" },
  };
  const execute = vi
    .fn()
    .mockResolvedValueOnce([injection(), injection([], playerUrl, "player", 1)])
    .mockResolvedValueOnce([xmlResult])
    .mockResolvedValueOnce([{ documentId: "top" }, { documentId: "player" }]);
  chromeMock(execute);
  expect(await detectCaptions()).toMatchObject({
    status: "success",
    captions: [{ items, itemCount: 2, source: "player_vtt" }],
  });
  expect(execute.mock.calls[1]?.[0].target).toEqual({
    tabId: 7,
    documentIds: ["player"],
  });
  expect(execute.mock.calls[1]?.[0].args).toEqual([
    "player",
    expect.any(Number),
  ]);
});
it("drops results when the iframe navigates", async () => {
  const execute = vi
    .fn()
    .mockResolvedValueOnce([
      injection(),
      injection(items, playerUrl, "player", 1),
    ])
    .mockResolvedValueOnce([
      { documentId: "top" },
      { documentId: "replacement" },
    ]);
  chromeMock(execute);
  expect(await detectCaptions()).toEqual({
    status: "error",
    code: "RELOAD_TAB",
  });
});
it("bounds injection timeout and never downloads during detection", async () => {
  vi.useFakeTimers();
  const execute = vi.fn().mockReturnValue(new Promise(() => {}));
  chromeMock(execute);
  const result = detectCaptions();
  await vi.advanceTimersByTimeAsync(15000);
  expect(await result).toEqual({ status: "error", code: "TIMEOUT" });
});

it("times out a stalled active-tab query and never injects after it resolves late", async () => {
  vi.useFakeTimers();
  const execute = vi.fn().mockResolvedValue([injection(items)]);
  const { get, query } = chromeMock(execute);
  let finishQuery: (
    tabs: { id: number; url: string; title: string }[],
  ) => void = () => {};
  query.mockReturnValue(
    new Promise((resolve) => {
      finishQuery = resolve;
    }),
  );
  const settled = vi.fn();
  void detectCaptions().then(settled);

  await vi.advanceTimersByTimeAsync(15000);
  expect.soft(settled).toHaveBeenCalledWith({
    status: "error",
    code: "TIMEOUT",
  });

  finishQuery([
    { id: 7, url: transcript.sourceUrl, title: transcript.pageTitle },
  ]);
  await vi.advanceTimersByTimeAsync(0);
  expect(execute).not.toHaveBeenCalled();
  expect(get).not.toHaveBeenCalled();
});

it("never checks the tab after verification resolves beyond the deadline", async () => {
  vi.useFakeTimers();
  let finishVerification: (result: { documentId: string }[]) => void = () => {};
  const execute = vi
    .fn()
    .mockResolvedValueOnce([injection(items)])
    .mockReturnValueOnce(
      new Promise((resolve) => {
        finishVerification = resolve;
      }),
    );
  const { get } = chromeMock(execute);
  const pending = detectCaptions();
  await vi.advanceTimersByTimeAsync(0);

  await vi.advanceTimersByTimeAsync(15000);
  expect(await pending).toEqual({ status: "error", code: "TIMEOUT" });

  finishVerification([{ documentId: "top" }]);
  await vi.advanceTimersByTimeAsync(0);
  expect(get).not.toHaveBeenCalled();
});

it("does not fetch VTT after the caption deadline expires during XML fetch", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-13T00:00:00.000Z"));
  player();
  let finishXml: (response: Response) => void = () => {};
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishXml = resolve;
        }),
    )
    .mockResolvedValueOnce(new Response(vtt));
  vi.stubGlobal("fetch", fetcher);
  const pending = collectCaptionSources("player", Date.now() + 5000);
  await vi.advanceTimersByTimeAsync(5000);

  finishXml(
    new Response(
      '<captions><caption lang="ko" label="국문" src="ko.vtt"/></captions>',
    ),
  );
  expect(await pending).toMatchObject({ blocked: true, vtt: "" });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("uses KU prototype data and uri elements, skips the intro without changing current story", async () => {
  const info = Object.assign(
    Object.create({ useCaption: true, captionUri: null }),
    {
      contentType: "video1",
      contentUri: "https://kucom.korea.ac.kr/contents/example",
      currStoryIdx: 0,
      storyList: [
        { isIntro: true, storyFileNameList: { caption: "intro.xml" } },
        Object.assign(Object.create({ isIntro: false }), {
          storyFileNameList: { caption: "web_files/caption_list.xml" },
        }),
      ],
    },
  );
  const config = Object.assign(
    Object.create({ getContentPlayingInfoData: vi.fn() }),
    { _contentPlayingInfoData: info },
  );
  vi.stubGlobal("location", new URL(playerUrl));
  Object.assign(window, { uniPlayerConfig: config });
  const fetcher = responses(
    '<captions><caption id="1"><label>국문</label><lang>ko</lang><uri>web_files/ko.vtt</uri></caption></captions>',
  );
  expect(await collectCaptionSources("player")).toMatchObject({
    vtt,
    label: "국문",
    blocked: false,
  });
  expect(fetcher.mock.calls.map((call) => call[0])).toEqual([
    "https://kucom.korea.ac.kr/contents/example/web_files/caption_list.xml",
    "https://kucom.korea.ac.kr/contents/example/web_files/ko.vtt",
  ]);
  expect(info.currStoryIdx).toBe(0);
  expect(config.getContentPlayingInfoData).not.toHaveBeenCalled();
});
it.each(["static", "remix"])(
  "resolves the KU %s caption base",
  async (kind) => {
    const config = player();
    Object.assign(
      config._contentPlayingInfoData,
      kind === "static"
        ? { captionUri: "https://kucom.korea.ac.kr/static" }
        : {
            contentType: "remix",
            storyList: [
              {
                remixWebUri: "https://kucom.korea.ac.kr/remix",
                storyFileNameList: { caption: "caption_list.xml" },
              },
            ],
          },
    );
    const fetcher = responses(
      "<captions><caption><lang>ko</lang><uri>ko.vtt</uri></caption></captions>",
    );
    expect(await collectCaptionSources("player")).toMatchObject({
      vtt,
      blocked: false,
    });
    const base = kind === "static" ? "static" : "remix";
    expect(fetcher.mock.calls.map((call) => call[0])).toEqual([
      `https://kucom.korea.ac.kr/${base}/caption_list.xml`,
      `https://kucom.korea.ac.kr/${base}/ko.vtt`,
    ]);
  },
);

it("recognizes already-loaded KU UPF TXT scripts without fetching or executing getters", async () => {
  player();
  const script =
    "제목: 녹화\r\n생성일: 2026-09-08\r\n\r\n[14:52:49 ~ 14:52:52]\r\n마이크 테스트.\r\nMic check.";
  const getter = vi.fn();
  const ignored = {};
  Object.defineProperty(ignored, "script", { get: getter });
  Object.assign(
    (window as unknown as { uniPlayerConfig: object }).uniPlayerConfig,
    {
      _mediaScriptList: [
        ignored,
        { label: "default_script", lang: "script", script },
      ],
    },
  );
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  expect(await collectCaptionSources("script")).toMatchObject({
    source: "player_media_script",
    script,
    label: "default_script",
    blocked: false,
  });
  expect(getter).not.toHaveBeenCalled();
  expect(fetcher).not.toHaveBeenCalled();
});
it("falls back to loaded scripts when a generated caption XML filename returns HTML", async () => {
  const p = injection([], playerUrl, "player", 1);
  const execute = vi
    .fn()
    .mockResolvedValueOnce([injection(), p])
    .mockResolvedValueOnce([{ ...p, result: { ...p.result, blocked: true } }])
    .mockResolvedValueOnce([
      {
        ...p,
        result: {
          ...p.result,
          source: "player_media_script",
          script: "[14:52:49 ~ 14:52:52]\n테스트 문장",
        },
      },
    ])
    .mockResolvedValueOnce([{ documentId: "top" }, { documentId: "player" }]);
  chromeMock(execute);
  expect(await detectCaptions()).toMatchObject({
    status: "success",
    captions: [
      {
        source: "player_media_script",
        items: [{ index: 0, time: "14:52:49", text: "테스트 문장" }],
      },
    ],
  });
  expect(execute.mock.calls[2]?.[0]).toMatchObject({
    target: { tabId: 7, documentIds: ["player"] },
    world: "MAIN",
    args: ["script"],
  });
});
it("preserves original script clock times and bilingual lines without treating the header as a cue", async () => {
  const { parseMediaScript } = await import("../src/captions/transcript");
  expect(
    parseMediaScript(
      "제목: 녹화\n생성일: 오늘\n\n[14:52:49 ~ 14:52:52]\n마이크 테스트.\nMic check.\n\n[14:54:21 ~ 14:54:24]\n다음",
    ),
  ).toEqual([
    { index: 0, time: "14:52:49", text: "마이크 테스트. Mic check." },
    { index: 1, time: "14:54:21", text: "다음" },
  ]);
  expect(parseMediaScript("시간 없는 원문\n두 번째 줄")).toEqual([
    { index: 0, time: "", text: "시간 없는 원문 두 번째 줄" },
  ]);
  expect(() => parseMediaScript("<html>오류</html>")).toThrow();
});
