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
  title: null,
  durationS: null,
};

vi.mock("../entrypoints/sidepanel/useAiCaptions", () => ({
  useAiCaptions: () => ({
    state: current,
    generate,
    cancel,
  }),
}));
vi.mock("../src/captions/download", async (original) => ({
  ...(await original<object>()),
  downloadCaption,
}));
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

async function render(onSettings?: () => void) {
  const { AiCaptionsSection } = await import(
    "../entrypoints/sidepanel/AiCaptionsSection"
  );
  ui = await mount(<AiCaptionsSection onSettings={onSettings} />);
}

it("confirms the server and audio before generating", async () => {
  await render();
  await click("AI 자막 만들기");
  expect(generate).not.toHaveBeenCalled();
  await click("음성 보내기");
  expect(generate).toHaveBeenCalledOnce();
});

it("previews the transcript and downloads each file on success", async () => {
  current = {
    ...base,
    phase: "succeeded",
    title: "3주차 강의",
    durationS: 4320,
    expiresAt: "2027-04-24T12:00:00Z",
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
  expect(ui.host.querySelector("h3")?.textContent).toBe("3주차 강의");
  expect(ui.host.textContent).toContain("문장 2개 · 1시간 12분");
  expect(ui.host.textContent).toContain("2027년 4월 24일까지 다시 받을 수 있어요");
  expect(ui.host.textContent).not.toContain("whisper-large-v3-turbo");
  expect(
    [...ui.host.querySelectorAll(".ai-preview li")].map((li) => li.textContent),
  ).toEqual(["00:00a", "00:05b"]);
  await click("TXT 받기");
  expect(downloadCaption).toHaveBeenLastCalledWith(
    expect.objectContaining({ itemCount: 2 }),
    { variant: "ai", only: "txt" },
  );
  expect(ui.host.textContent).toContain("output/ 폴더로 TXT 다운로드를 시작했어요.");
  await click("JSON 받기");
  expect(downloadCaption).toHaveBeenLastCalledWith(
    expect.objectContaining({ itemCount: 2 }),
    { variant: "ai", only: "json" },
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
    "AI 자막 만들기",
  );
});

it("sends a signed-out user straight to the AI settings to log in", async () => {
  session = null;
  const onSettings = vi.fn();
  await render(onSettings);
  await click("로그인하러 가기");
  expect(onSettings).toHaveBeenCalledOnce();
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
  expect(ui.host.textContent).toContain("10 / 65분");
  expect(ui.host.querySelector(".ai-big")?.textContent).toBe("15%");
  expect(
    ui.host.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow"),
  ).toBe("15");
});

it("marks finished steps and tells whether the panel may close", async () => {
  current = { ...base, phase: "uploading", progress: 5 * 1024 * 1024 };
  await render();
  const steps = [...ui.host.querySelectorAll(".ai-steps li")];
  expect(steps.map((li) => li.className)).toEqual(["done", "done", "now", "", ""]);
  expect(steps[2]?.textContent).toContain("5.0MB");
  expect(ui.host.textContent).toContain("패널을 열어 두세요");
  await ui.unmount();
  current = { ...base, phase: "queued" };
  await render();
  expect(ui.host.textContent).toContain("패널을 닫아도 계속 진행돼요");
});

it("offers settings instead of a retry when only settings can fix the failure", async () => {
  const onSettings = vi.fn();
  current = { ...base, phase: "failed", errorCode: "ACCOUNT_NOT_ALLOWED" };
  await render(onSettings);
  const labels = [...ui.host.querySelectorAll("button")].map((b) => b.textContent);
  expect(labels).not.toContain("다시 시도");
  await click("AI 자막 설정");
  expect(onSettings).toHaveBeenCalledOnce();
});
