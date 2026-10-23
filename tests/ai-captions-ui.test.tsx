// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mount, click } from "./ui-helpers";
import type { AiCaptionState } from "../entrypoints/sidepanel/useAiCaptions";

const generate = vi.hoisted(() => vi.fn());
const cancel = vi.hoisted(() => vi.fn());
const downloadCaption = vi.hoisted(() => vi.fn());
let current: AiCaptionState;

vi.mock("../entrypoints/sidepanel/useAiCaptions", () => ({
  useAiCaptions: () => ({
    state: current,
    generate,
    cancel,
    serverOrigin: "https://captions.test",
  }),
}));
vi.mock("../src/captions/download", () => ({ downloadCaption }));

let ui: Awaited<ReturnType<typeof mount>>;

beforeEach(() => {
  current = {
    phase: "idle",
    progress: null,
    errorCode: null,
    expiresAt: null,
    result: null,
  };
  vi.stubGlobal("chrome", { runtime: { sendMessage: vi.fn(async () => undefined) } });
  downloadCaption.mockResolvedValue({ status: "complete" });
});
afterEach(async () => {
  await ui?.unmount();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function render() {
  const { AiCaptionsSection } = await import(
    "../entrypoints/sidepanel/AiCaptionsSection"
  );
  ui = await mount(<AiCaptionsSection />);
}

it("confirms the server and audio before generating", async () => {
  await render();
  await click("AI 자막 생성");
  expect(ui.host.textContent).toContain("https://captions.test");
  expect(generate).not.toHaveBeenCalled();
  await click("음성 보내기");
  expect(generate).toHaveBeenCalledOnce();
});

it("shows the engine and offers download on success", async () => {
  current = {
    phase: "succeeded",
    progress: null,
    errorCode: null,
    expiresAt: null,
    result: {
      engine: "whisper-large-v3-turbo",
      modelRevision: "r1",
      transcript: {
        sourceUrl: "https://kucom.korea.ac.kr/",
        pageTitle: "AI 자막",
        extractedAt: "2026-10-23T00:00:00Z",
        itemCount: 2,
        items: [
          { index: 0, time: "00:00", text: "a" },
          { index: 1, time: "00:05", text: "b" },
        ],
      },
    },
  };
  await render();
  expect(ui.host.textContent).toContain("whisper-large-v3-turbo");
  await click("AI 자막 TXT·JSON 다운로드");
  expect(downloadCaption).toHaveBeenCalledWith(
    expect.objectContaining({ itemCount: 2 }),
    { variant: "ai" },
  );
});

it("surfaces a failure message", async () => {
  current = {
    phase: "failed",
    progress: null,
    errorCode: "NO_TOKEN",
    expiresAt: null,
    result: null,
  };
  await render();
  expect(ui.host.textContent).toContain("토큰");
});

it("explains a CDN refusal and a CDN network failure instead of a missing audio track", async () => {
  for (const [errorCode, text] of [
    ["MEDIA_DENIED", "강의 영상 서버가 요청을 거부했습니다"],
    ["MEDIA_NETWORK", "강의 영상 서버에서 음성을 받지 못했습니다"],
  ] as const) {
    current = { phase: "failed", progress: null, errorCode, expiresAt: null, result: null };
    await render();
    expect(ui.host.textContent).toContain(text);
    expect(ui.host.textContent).not.toContain("음성 트랙을 찾지 못했습니다");
    await ui.unmount();
  }
});
