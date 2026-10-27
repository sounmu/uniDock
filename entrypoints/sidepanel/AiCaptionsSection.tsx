import { useState } from "react";
import { downloadCaption } from "../../src/captions/download";
import { featureResult } from "./analytics";
import { useAiCaptions } from "./useAiCaptions";
import { useCaptionSession } from "./useCaptionSession";

const phaseText: Record<string, string> = {
  identifying: "강의 영상을 확인하고 있습니다…",
  extracting: "음성 트랙을 분리하고 있습니다…",
  uploading: "자막 서버로 음성을 보내고 있습니다…",
  queued: "서버에서 대기 중입니다…",
  running: "자막을 생성하고 있습니다…",
};

const errorText: Record<string, string> = {
  ACTIVATE_TAB: "KU 강의 플레이어 탭을 선택한 뒤 다시 시도하세요.",
  PERMISSION: "강의 영상 서버 접근을 허용해야 음성을 분리할 수 있습니다.",
  UNSUPPORTED_MEDIA: "이 강의에서는 음성 트랙을 찾지 못했습니다.",
  MEDIA_DENIED:
    "강의 영상 서버가 요청을 거부했습니다. 플레이어 탭을 새로 고친 뒤 다시 시도하세요.",
  MEDIA_NETWORK: "강의 영상 서버에서 음성을 받지 못했습니다. 다시 시도하세요.",
  TOO_LARGE: "음성이 너무 깁니다. 서버 제한을 넘었습니다.",
  NO_SERVER: "자막 서버 주소가 설정되지 않았습니다.",
  LOGIN_REQUIRED: "설정에서 Google 계정으로 다시 로그인하세요.",
  ACCOUNT_NOT_ALLOWED: "이 Google 계정으로는 AI 자막을 쓸 수 없습니다.",
  QUOTA_EXCEEDED:
    "이번 주 사용 횟수(주 7회)를 모두 썼습니다. 매주 월요일 0시(KST)에 다시 채워집니다.",
  ACTIVE_JOB_EXISTS:
    "다른 강의의 AI 자막 생성이 진행 중입니다. 끝난 뒤 다시 시도하세요.",
  RATE_LIMITED: "요청이 너무 잦습니다. 잠시 후 다시 시도하세요.",
  UPLOAD_CONFLICT:
    "업로드가 서버 기록과 계속 맞지 않아 멈췄습니다. 잠시 후 다시 시도하세요.",
  UNAVAILABLE: "자막 서버가 점검 중입니다. 잠시 후 다시 시도하세요.",
  EXPIRED: "자막이 만료되었거나 작업을 찾을 수 없습니다.",
  NETWORK: "자막 서버에 연결하지 못했습니다.",
  UNSUPPORTED_AUDIO: "서버가 이 음성 형식을 처리하지 못했습니다.",
  DURATION_TOO_LONG: "4시간을 넘는 강의는 지원하지 않습니다.",
  SIZE_MISMATCH: "업로드가 손상됐습니다. 다시 시도하세요.",
  UPLOAD_EXPIRED: "업로드가 끝나지 않아 취소됐습니다. 다시 시도하세요.",
  INFERENCE_TIMEOUT: "처리 시간이 초과됐습니다. 이번 사용 횟수는 돌려받습니다.",
  INFERENCE_FAILED: "자막 생성에 실패했습니다. 이번 사용 횟수는 돌려받습니다.",
};

function serverProgressText(progress: { done?: number; total?: number } | null) {
  if (!progress?.total || progress.done === undefined) return "";
  const minutes = (seconds: number) => Math.floor(seconds / 60);
  return `${minutes(progress.done)}분 / ${minutes(progress.total)}분 처리`;
}

/** Rows inside the captions panel's AI offer card. */
export function AiCaptionsSection({
  onSettings,
}: {
  readonly onSettings?: () => void;
} = {}) {
  const { state, generate, cancel, serverOrigin } = useAiCaptions();
  const session = useCaptionSession();
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState("");
  const running =
    state.phase !== "idle" &&
    state.phase !== "succeeded" &&
    state.phase !== "failed" &&
    state.phase !== "cancelled";

  async function exportResult() {
    const result = state.result;
    if (!result) return;
    const report = featureResult("captions_ai");
    try {
      const outcome = await downloadCaption(result.transcript, { variant: "ai" });
      report(outcome.status === "complete");
      setNotice(
        outcome.status === "complete"
          ? "output/에 AI 자막 TXT·JSON 다운로드를 요청했습니다."
          : "다운로드를 일부만 요청했습니다. 다운로드 목록을 확인하세요.",
      );
    } catch {
      report(false);
      setNotice("다운로드를 요청하지 못했습니다. 다시 시도하세요.");
    }
  }

  if (confirming) {
    return (
      <div role="group" aria-label="AI 자막 생성 확인">
        <div className="settings-row">
          <div className="row-text">
            <p className="row-title">음성을 보내기 전에 확인하세요</p>
            <ul className="confirm-list">
              <li>
                현재 강의의 음성만 {serverOrigin}(으)로 보내며 영상은 보내지
                않습니다.
              </li>
              <li>
                음성은 자막을 만든 뒤 서버에서 삭제하고, 자막은 최대 6개월
                보관합니다. 같은 강의의 기존 자막에 연결되면 더 짧을 수 있으며
                만료일은 완료 후 표시합니다.
              </li>
              <li>이번 주 사용 횟수가 1회 차감됩니다.</li>
              <li>AI가 만든 자막이라 원본 자막과 다를 수 있습니다.</li>
              <li>강의 영상 서버 접근을 묻는 창이 뜨면 허용하세요.</li>
            </ul>
          </div>
        </div>
        <div className="settings-row row-actions">
          <button
            className="btn-primary"
            data-analytics-action="captions_ai_confirm"
            onClick={() => {
              setConfirming(false);
              setNotice("");
              void generate();
            }}
          >
            음성 보내기
          </button>
          <button className="btn-ghost" onClick={() => setConfirming(false)}>
            취소
          </button>
        </div>
      </div>
    );
  }

  if (session === undefined) return null;
  if (session === null && !running && state.phase !== "succeeded")
    return (
      <div className="settings-row">
        <div className="row-text">
          <p className="row-sub" role="status">
            AI 자막을 쓰려면 설정에서 Google 계정으로 로그인하세요.
          </p>
        </div>
        {onSettings && (
          <div className="row-actions">
            <button className="btn-primary" onClick={onSettings}>
              로그인하러 가기
            </button>
          </div>
        )}
      </div>
    );

  return (
    <div aria-live="polite" aria-busy={running}>
      {state.phase === "idle" && (
        <div className="settings-row row-actions">
          <button
            className="btn-primary"
            data-analytics-action="captions_ai_generate"
            onClick={() => setConfirming(true)}
          >
            AI 자막 생성
          </button>
        </div>
      )}
      {running && (
        <div className="settings-row">
          <div className="row-text">
            <p className="row-title">{phaseText[state.phase] ?? "진행 중…"}</p>
            {state.phase === "running" && serverProgressText(state.serverProgress) && (
              <p className="row-sub">{serverProgressText(state.serverProgress)}</p>
            )}
            {state.phase === "queued" && state.workerOffline && (
              <p className="row-sub">
                처리 서버가 꺼져 있어 대기합니다. 켜지면 이어서 처리합니다.
              </p>
            )}
          </div>
          <div className="row-actions">
            <button
              className="btn-ghost"
              data-analytics-action="captions_ai_cancel"
              onClick={() => cancel()}
            >
              취소
            </button>
          </div>
        </div>
      )}
      {state.phase === "failed" && (
        <div className="settings-row">
          <div className="row-text">
            <p className="row-sub row-error" role="alert">
              {(state.errorCode && errorText[state.errorCode]) ||
                "AI 자막 생성에 실패했습니다. 다시 시도하세요."}
            </p>
          </div>
          <div className="row-actions">
            <button
              className="btn-secondary"
              data-analytics-action="captions_ai_generate"
              onClick={() => setConfirming(true)}
            >
              다시 시도
            </button>
          </div>
        </div>
      )}
      {state.phase === "succeeded" && state.result && (
        <div className="settings-row">
          <div className="row-text">
            <p className="row-title">
              AI 생성 자막 · {state.result.transcript.itemCount.toLocaleString()}개
              문장
            </p>
            <p className="row-sub">
              엔진 {state.result.engine || "미상"}
              {state.result.modelRevision ? ` · ${state.result.modelRevision}` : ""} ·
              추론 결과라 원본 자막과 다를 수 있습니다.
            </p>
            {state.expiresAt && (
              <p className="row-sub">
                서버 보관 만료일: {new Date(state.expiresAt).toLocaleString()}
              </p>
            )}
          </div>
          <div className="row-actions">
            <button
              className="btn-primary"
              data-analytics-action="captions_ai"
              onClick={() => void exportResult()}
            >
              AI 자막 TXT·JSON 다운로드
            </button>
          </div>
        </div>
      )}
      {notice && (
        <p className="settings-row row-sub" role="status">
          {notice}
        </p>
      )}
    </div>
  );
}
