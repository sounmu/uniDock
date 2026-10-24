// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mount, click } from "./ui-helpers";
import type { AiCaptionState } from "../entrypoints/sidepanel/useAiCaptions";

const generate = vi.hoisted(() => vi.fn());
const cancel = vi.hoisted(() => vi.fn());
const downloadCaption = vi.hoisted(() => vi.fn());
let current: AiCaptionState;
let session: { email: string } | null = { email: "student@example.com" };
const base: AiCaptionState = {
  phase: "idle",
  progress: null,
  serverProgress: null,
  workerOffline: false,
  errorCode: null,
  expiresAt: null,
  result: null,
};

vi.mock("../entrypoints/sidepanel/useAiCaptions", () => ({
  useAiCaptions: () => ({
    state: current,
    generate,
    cancel,
    serverOrigin: "https://captions.test",
  }),
}));
vi.mock("../src/captions/download", () => ({ downloadCaption }));
vi.mock("../entrypoints/sidepanel/useCaptionSession", () => ({
  useCaptionSession: () => session,
}));

let ui: Awaited<ReturnType<typeof mount>>;

beforeEach(() => {
  current = { ...base };
  session = { email: "student@example.com" };
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
  expect(ui.host.textContent).toContain("최대 6개월");
  expect(ui.host.textContent).toContain("1회 차감");
  expect(generate).not.toHaveBeenCalled();
  await click("음성 보내기");
  expect(generate).toHaveBeenCalledOnce();
});

it("shows the engine and offers download on success", async () => {
  current = {
    ...base,
    phase: "succeeded",
    expiresAt: "2027-04-24T03:05:00Z",
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
  current = { ...base, phase: "failed", errorCode: "LOGIN_REQUIRED" };
  await render();
  expect(ui.host.textContent).toContain("Google 계정으로 다시 로그인");
});

it("explains a CDN refusal and a CDN network failure instead of a missing audio track", async () => {
  for (const [errorCode, text] of [
    ["MEDIA_DENIED", "강의 영상 서버가 요청을 거부했습니다"],
    ["MEDIA_NETWORK", "강의 영상 서버에서 음성을 받지 못했습니다"],
  ] as const) {
    current = { ...base, phase: "failed", errorCode };
    await render();
    expect(ui.host.textContent).toContain(text);
    expect(ui.host.textContent).not.toContain("음성 트랙을 찾지 못했습니다");
    await ui.unmount();
  }
});

it("asks for Google login instead of offering generation when signed out", async () => {
  session = null;
  await render();
  expect(ui.host.textContent).toContain("Google 계정으로 로그인");
  expect([...ui.host.querySelectorAll("button")].map((b) => b.textContent)).not.toContain(
    "AI 자막 생성",
  );
});

it("shows the weekly quota, an offline worker and transcription progress", async () => {
  current = { ...base, phase: "failed", errorCode: "QUOTA_EXCEEDED" };
  await render();
  expect(ui.host.textContent).toContain("주 7회");
  await ui.unmount();
  current = { ...base, phase: "queued", workerOffline: true };
  await render();
  expect(ui.host.textContent).toContain("처리 서버가 꺼져 있어");
  await ui.unmount();
  current = { ...base, phase: "running", serverProgress: { stage: "transcribing", done: 600, total: 3938 } };
  await render();
  expect(ui.host.textContent).toContain("10분 / 65분 처리");
});
