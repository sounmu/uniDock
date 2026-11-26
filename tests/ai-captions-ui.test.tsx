// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act } from "react";
import { mount, click, deferred } from "./ui-helpers";
import type { AiCaptionState } from "../entrypoints/sidepanel/useAiCaptions";

const generate = vi.hoisted(() => vi.fn());
const cancel = vi.hoisted(() => vi.fn());
const downloadCaption = vi.hoisted(() => vi.fn());
const getAccount = vi.hoisted(() => vi.fn());
let current: AiCaptionState;
let session: { email: string; loginId: string } | null = {
  email: "student@example.com",
  loginId: "login-a",
};
const base: AiCaptionState = {
  phase: "idle",
  serverProgress: null,
  workerOffline: false,
  errorCode: null,
  expiresAt: null,
  result: null,
  title: null,
  durationS: null,
  restoredFromCache: false,
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
vi.mock("../src/captions/job-client", async (original) => ({
  ...(await original<object>()),
  getAccount,
}));
vi.mock("../entrypoints/sidepanel/useCaptionSession", () => ({
  useCaptionSession: () => session,
}));

let ui: Awaited<ReturnType<typeof mount>>;

beforeEach(() => {
  current = { ...base };
  session = { email: "student@example.com", loginId: "login-a" };
  vi.stubGlobal("chrome", { runtime: { sendMessage: vi.fn(async () => undefined) } });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  downloadCaption.mockResolvedValue({ status: "complete" });
  getAccount.mockRejectedValue(new Error("offline"));
});

const account = (used: number, reserved = 0, resetsAt = "2026-11-27T00:00:00+09:00") => ({
  email: "student@example.com",
  quota: { limit: 7, used, reserved, resetsAt },
});

it("shows today's remaining count before generating and in the confirmation", async () => {
  getAccount.mockResolvedValue(account(2, 1));
  await render();
  expect(ui.host.querySelector(".ai-facts")?.textContent).toContain("4 / 7회");
  await click("AI 자막 만들기");
  expect(ui.host.textContent).toContain("오늘 남은 4회 중 1회가 차감돼요");
});

it("reads the quota again once it resets", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  getAccount.mockResolvedValueOnce(account(7, 0, new Date(Date.now() + 1_000).toISOString()));
  getAccount.mockResolvedValue(account(0));
  await render();
  expect(ui.host.querySelector(".ai-facts")?.textContent).toContain("0 / 7회");
  await act(async () => vi.advanceTimersByTime(2_100));
  expect(ui.host.querySelector(".ai-facts")?.textContent).toContain("7 / 7회");
  vi.useRealTimers();
});

it("never shows another sign-in's quota", async () => {
  getAccount.mockResolvedValueOnce(account(7));
  await render();
  expect(ui.host.querySelector(".ai-facts")?.textContent).toContain("0 / 7회");
  const pending = deferred<ReturnType<typeof account>>();
  getAccount.mockReturnValueOnce(pending.promise);
  session = { email: "other@example.com", loginId: "login-b" };
  const { AiCaptionsSection } = await import("../entrypoints/sidepanel/AiCaptionsSection");
  await ui.render(<AiCaptionsSection />);
  expect(ui.host.querySelector(".ai-facts")?.textContent).not.toContain("0 / 7회");
  await act(async () => pending.resolve(account(1)));
  expect(ui.host.querySelector(".ai-facts")?.textContent).toContain("6 / 7회");
});

it("blocks generation once today's quota is spent", async () => {
  getAccount.mockResolvedValue(account(7));
  await render();
  expect(ui.host.querySelector(".ai-facts")?.textContent).toContain("0 / 7회");
  await click("AI 자막 만들기");
  expect(ui.host.querySelector('[aria-label="AI 자막 생성 확인"]')).toBeNull();
  expect(generate).not.toHaveBeenCalled();
});
afterEach(async () => {
  await ui?.unmount();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function render(onSettings?: () => void, restoreOnly = false) {
  const { AiCaptionsSection } = await import(
    "../entrypoints/sidepanel/AiCaptionsSection"
  );
  ui = await mount(<AiCaptionsSection onSettings={onSettings} restoreOnly={restoreOnly} />);
}

it("leaves no card or generation controls while looking for a cache without a result", async () => {
  await render(undefined, true);
  expect(ui.host.querySelector(".ai-offer")).toBeNull();
  expect(ui.host.querySelector("button")).toBeNull();
});

it("shows an automatic restore failure with a retry action", async () => {
  current = { ...base, phase: "failed", errorCode: "NETWORK" };
  await render(undefined, true);
  expect(ui.host.querySelector('[role="alert"]')?.textContent).toContain("연결하지 못했습니다");
  await click("다시 시도");
  expect(ui.host.querySelector('[aria-label="AI 자막 생성 확인"]')).not.toBeNull();
});

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
  expect(ui.host.textContent).toContain("uniDock/ 폴더로 TXT 다운로드를 시작했어요.");
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

it.each([false, true])("renders every caption when restoredFromCache is %s", async (restoredFromCache) => {
  const items = Array.from({ length: 350 }, (_, index) => ({
    index, time: "00:00", text: `문장 ${index + 1}`,
  }));
  current = {
    ...base, phase: "succeeded", restoredFromCache,
    result: { engine: "whisper", modelRevision: "r1", transcript: {
      sourceUrl: "https://kucom.korea.ac.kr/", pageTitle: "강의 자막",
      extractedAt: "2026-11-05T00:00:00Z", itemCount: items.length, items,
    } },
  };
  await render();
  const list = ui.host.querySelector('[aria-label="전체 자막"]');
  expect(list?.querySelectorAll("li")).toHaveLength(350);
  expect(list?.lastElementChild?.textContent).toContain("문장 350");
  expect(ui.host.querySelector(".ai-reader") !== null).toBe(restoredFromCache);
  if (restoredFromCache) {
    expect(ui.host.querySelector(".btn-primary")).toBeNull();
    await click("TXT 받기");
    expect(downloadCaption).toHaveBeenCalledWith(current.result?.transcript, {
      variant: "ai", only: "txt",
    });
  }
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

it("shows the daily quota, a plain queue state and transcription progress", async () => {
  current = { ...base, phase: "failed", errorCode: "QUOTA_EXCEEDED" };
  await render();
  expect(ui.host.textContent).toContain("하루 7회");
  await ui.unmount();
  current = { ...base, phase: "queued", workerOffline: true };
  await render();
  expect(ui.host.textContent).toContain("대기열에 있어요");
  expect(ui.host.textContent).not.toContain("서버");
  await ui.unmount();
  current = { ...base, phase: "running", serverProgress: { stage: "transcribing", done: 600, total: 3938 } };
  await render();
  expect(ui.host.textContent).toContain("10 / 65분");
  expect(ui.host.querySelector(".ai-big")?.textContent).toBe("15%");
  expect(
    ui.host.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow"),
  ).toBe("15");
});

it("marks finished steps and says at every step that the panel may close", async () => {
  current = { ...base, phase: "uploading" };
  await render();
  const steps = [...ui.host.querySelectorAll(".ai-steps li")];
  expect(steps.map((li) => li.className)).toEqual(["now", "", ""]);
  expect(steps[0]?.textContent).not.toContain("MB");
  expect(ui.host.textContent).toContain("패널을 닫아도 계속 진행돼요");
  expect(ui.host.textContent).not.toContain("패널을 열어 두세요");
  await ui.unmount();
  current = { ...base, phase: "queued" };
  await render();
  const queued = [...ui.host.querySelectorAll(".ai-steps li")];
  expect(queued.map((li) => li.className)).toEqual(["done", "now", ""]);
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
