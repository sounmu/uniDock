import { useState } from "react";
import { downloadCaption } from "../../src/captions/download";
import { Notice } from "./ui/Notice";
import { featureResult } from "./analytics";
import { useAiCaptions } from "./useAiCaptions";

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
  TOO_LARGE: "음성이 너무 깁니다. 서버 제한을 넘었습니다.",
  NO_SERVER: "자막 서버 주소가 설정되지 않았습니다.",
  NO_TOKEN: "정보 화면에서 자막 서버 토큰을 먼저 저장하세요.",
  AUTH: "자막 서버 토큰이 거부되었습니다. 토큰을 다시 확인하세요.",
  RATE_LIMITED: "요청이 한도를 넘었습니다. 잠시 후 다시 시도하세요.",
  EXPIRED: "자막이 만료되었거나 작업을 찾을 수 없습니다.",
  NETWORK: "자막 서버에 연결하지 못했습니다.",
};

export function AiCaptionsSection() {
  const { state, generate, cancel, serverOrigin } = useAiCaptions();
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
      <div className="settings-card" role="group" aria-label="AI 자막 생성 확인">
        <p className="hint">
          현재 강의의 음성을 {serverOrigin} 으로 보냅니다. 음성은 자막 생성 후
          서버에서 삭제되고, 자막은 서버가 작업을 받을 때 알려 주는 만료일까지
          보관됩니다. 만료일은 진행 화면에 표시됩니다. 결과는 추론으로 만든
          자막이라 원본 자막과 다를 수 있습니다. 강의 영상 서버 접근 권한을
          묻는 창이 열리면 허용해야 합니다.
        </p>
        <div className="row-actions">
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

  return (
    <div aria-live="polite" aria-busy={running}>
      {state.phase === "idle" && (
        <button
          className="btn-primary"
          data-analytics-action="captions_ai_generate"
          onClick={() => setConfirming(true)}
        >
          AI 자막 생성
        </button>
      )}
      {running && (
        <div className="row-actions">
          <p className="count">{phaseText[state.phase] ?? "진행 중…"}</p>
          {state.expiresAt && (
            <p className="row-sub">
              자막 보관 만료일: {new Date(state.expiresAt).toLocaleString()}
            </p>
          )}
          <button
            className="btn-ghost"
            data-analytics-action="captions_ai_cancel"
            onClick={() => cancel()}
          >
            취소
          </button>
        </div>
      )}
      {state.phase === "failed" && (
        <>
          <Notice error>
            {(state.errorCode && errorText[state.errorCode]) ||
              "AI 자막 생성에 실패했습니다. 다시 시도하세요."}
          </Notice>
          <button
            className="btn-secondary"
            data-analytics-action="captions_ai_generate"
            onClick={() => setConfirming(true)}
          >
            다시 시도
          </button>
        </>
      )}
      {state.phase === "succeeded" && state.result && (
        <div className="settings-card">
          <p className="count">
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
          <button
            className="btn-primary"
            data-analytics-action="captions_ai"
            onClick={() => void exportResult()}
          >
            AI 자막 TXT·JSON 다운로드
          </button>
        </div>
      )}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
    </div>
  );
}
