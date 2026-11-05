import { useState, type ReactNode } from "react";
import { downloadCaption, exportTranscript } from "../../src/captions/download";
import { coreResult, startOperation } from "./analytics";
import { useAiCaptions, type AiCaptionState } from "./useAiCaptions";
import { useCaptionSession } from "./useCaptionSession";

const steps = [
  ["identifying", "영상 확인"],
  ["extracting", "음성 분리"],
  ["uploading", "업로드"],
  ["queued", "대기"],
  ["running", "자막 생성"],
] as const;

const phaseText: Record<string, string> = {
  identifying: "강의 영상을 확인하고 있어요",
  extracting: "강의 음성을 분리하고 있어요",
  uploading: "음성을 보내고 있어요",
  queued: "처리 순서를 기다리고 있어요",
  running: "자막을 만들고 있어요",
};

const heroText: Record<string, string> = {
  identifying: "영상 확인 중",
  extracting: "음성 분리 중",
  uploading: "업로드 중",
  queued: "순서 기다리는 중",
  running: "자막 생성 중",
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

const settingsErrors = new Set(["LOGIN_REQUIRED", "ACCOUNT_NOT_ALLOWED", "NO_SERVER"]);
const finalErrors = new Set([
  "QUOTA_EXCEEDED",
  "DURATION_TOO_LONG",
  "ACCOUNT_NOT_ALLOWED",
  "NO_SERVER",
]);

type Progress = AiCaptionState["serverProgress"];

function serverPercent(progress: Progress): number | null {
  if (!progress?.total || progress.done === undefined) return null;
  return Math.min(99, Math.floor((progress.done / progress.total) * 100));
}

function serverMinutes(progress: Progress): string {
  if (!progress?.total || progress.done === undefined || progress.total < 60) return "";
  const minutes = (seconds: number) => Math.floor(seconds / 60);
  return `${minutes(progress.done)} / ${minutes(progress.total)}분`;
}

function durationLabel(seconds: number): string {
  const total = Math.max(1, Math.round(seconds / 60));
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  if (!hours) return `${minutes}분`;
  return minutes ? `${hours}시간 ${minutes}분` : `${hours}시간`;
}

function sizeLabel(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)}MB`
    : `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

function expiryLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("ko-KR", { dateStyle: "long" }).format(date);
}

const checkIcon = (
  <svg
    className="ai-check"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </svg>
);

function Head({
  title,
  sub,
  chip,
  tone,
}: {
  readonly title: string;
  readonly sub?: string;
  readonly chip?: string;
  readonly tone?: "run" | "ok" | "bad";
}) {
  return (
    <div className="ai-job-head">
      <div className="ai-job-heading">
        <h3 id="ai-offer-title">{title}</h3>
        {sub && <p>{sub}</p>}
      </div>
      {chip && <span className={tone ? `ai-chip ${tone}` : "ai-chip"}>{chip}</span>}
    </div>
  );
}

function Body({ children, foot }: { readonly children?: ReactNode; readonly foot?: ReactNode }) {
  return (
    <div className="ai-job-body">
      {children}
      {foot && <div className="ai-foot">{foot}</div>}
    </div>
  );
}

export function AiCaptionsSection({ onSettings, reason = "NO_CAPTIONS" }: { readonly onSettings?: () => void; readonly reason?: "NO_CAPTIONS" | "UNSAFE_CAPTION" } = {}) {
  const { state, generate, cancel } = useAiCaptions();
  const session = useCaptionSession();
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState("");
  const running =
    state.phase !== "idle" &&
    state.phase !== "succeeded" &&
    state.phase !== "failed" &&
    state.phase !== "cancelled";
  const missing =
    reason === "NO_CAPTIONS" ? "제공된 자막이 없어요" : "제공된 자막을 읽을 수 없어요";
  const missingShort = reason === "NO_CAPTIONS" ? "제공된 자막 없음" : "자막 읽기 실패";
  const title = state.title ?? missing;
  const facts = [
    state.durationS ? `강의 영상 ${durationLabel(state.durationS)}` : "",
    state.title ? missingShort : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const settingsButton = onSettings && (
    <button className="btn-ghost" onClick={onSettings}>
      AI 자막 설정
    </button>
  );

  async function exportResult(only: "txt" | "json") {
    const result = state.result;
    if (!result) return;
    const op = startOperation("ai_captions_export");
    try {
      const outcome = await downloadCaption(result.transcript, { variant: "ai", only });
      if (outcome.status === "complete") {
        op.success();
        coreResult("ai_captions_exported");
      } else op.failure("PARTIAL");
      setNotice(
        outcome.status === "complete"
          ? `output/ 폴더로 ${only.toUpperCase()} 다운로드를 시작했어요.`
          : "다운로드를 요청하지 못했어요. 다운로드 목록을 확인하세요.",
      );
    } catch {
      op.failure("DOWNLOAD_FAILED");
      setNotice("다운로드를 요청하지 못했어요. 다시 시도하세요.");
    }
  }

  async function copyResult() {
    const result = state.result;
    if (!result) return;
    try {
      await navigator.clipboard.writeText(exportTranscript(result.transcript).text);
      setNotice("전체 자막을 복사했어요.");
    } catch {
      setNotice("복사하지 못했어요. TXT로 받아 주세요.");
    }
  }

  if (confirming)
    return (
      <div className="ai-job" role="group" aria-label="AI 자막 생성 확인">
        <Head title={title} sub={facts} chip="확인" />
        <Body
          foot={
            <>
              <button
                className="btn-primary"
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
            </>
          }
        >
          <div className="ai-fill">
            <p className="ai-lead">보내기 전에 확인해 주세요</p>
            <ul className="ai-checks">
              <li>{checkIcon}강의 음성만 보내고, 처리 후 지워요</li>
              <li>{checkIcon}자막은 6개월 동안 다시 받을 수 있어요</li>
              <li>{checkIcon}이번 주 사용 횟수 1회가 차감돼요</li>
            </ul>
          </div>
        </Body>
      </div>
    );

  if (session === undefined)
    return (
      <div className="ai-job">
        <Head title={title} />
      </div>
    );

  if (session === null && !running && state.phase !== "succeeded")
    return (
      <div className="ai-job">
        <Head title={title} sub={facts} chip="로그인 필요" />
        <Body
          foot={
            onSettings && (
              <button className="btn-primary" onClick={onSettings}>
                로그인하러 가기
              </button>
            )
          }
        >
          <div className="ai-fill" role="status">
            <p className="ai-lead">Google 계정으로 로그인하세요</p>
            <p className="ai-lead-sub">로그인하면 이 강의의 자막을 AI로 만들 수 있어요</p>
          </div>
        </Body>
      </div>
    );

  if (running) {
    const percent = state.phase === "running" ? serverPercent(state.serverProgress) : null;
    const current = steps.findIndex(([phase]) => phase === state.phase);
    const detail = (phase: string) => {
      if (phase !== state.phase) return "";
      if ((phase === "extracting" || phase === "uploading") && state.progress)
        return sizeLabel(state.progress);
      if (phase === "running") return serverMinutes(state.serverProgress);
      return "";
    };
    const accepted = state.phase === "queued" || state.phase === "running";
    return (
      <div className="ai-job" aria-live="polite" aria-busy="true">
        <Head title={title} sub={phaseText[state.phase] ?? "진행 중이에요"} chip="진행 중" tone="run" />
        <Body
          foot={
            <div className="ai-run-foot">
              <p className="ai-note">
                {state.phase === "queued" && state.workerOffline
                  ? "처리 서버가 꺼져 있어 기다리고 있어요. 켜지면 이어서 처리해요."
                  : accepted
                    ? "패널을 닫아도 계속 진행돼요"
                    : "음성을 보내는 동안 패널을 열어 두세요"}
              </p>
              <button className="btn-ghost" onClick={() => cancel()}>
                취소
              </button>
            </div>
          }
        >
          <div className="ai-hero">
            {percent !== null ? (
              <p className="ai-big">{percent}%</p>
            ) : (
              <p className="ai-hero-title">{heroText[state.phase] ?? "진행 중"}</p>
            )}
          </div>
          <div
            className={percent === null ? "ai-bar indeterminate" : "ai-bar"}
            role="progressbar"
            aria-label="AI 자막 진행률"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent ?? undefined}
          >
            <i style={percent === null ? undefined : { width: `${percent}%` }} />
          </div>
          <ol className="ai-steps">
            {steps.map(([phase, label], index) => (
              <li
                key={phase}
                className={index < current ? "done" : index === current ? "now" : undefined}
                aria-current={index === current ? "step" : undefined}
              >
                <span className="ai-dot">{index < current && checkIcon}</span>
                <span>{label}</span>
                <small>{detail(phase)}</small>
              </li>
            ))}
          </ol>
        </Body>
      </div>
    );
  }

  if (state.phase === "succeeded" && state.result) {
    const transcript = state.result.transcript;
    const expiry = state.expiresAt ? expiryLabel(state.expiresAt) : "";
    const sub = [
      `문장 ${transcript.itemCount.toLocaleString("ko-KR")}개`,
      state.durationS ? durationLabel(state.durationS) : "",
    ]
      .filter(Boolean)
      .join(" · ");
    return (
      <div className="ai-job" aria-live="polite">
        <Head title={title} sub={sub} chip="완료" tone="ok" />
        <Body
          foot={
            <>
              <button className="btn-primary" onClick={() => void exportResult("txt")}>
                TXT 받기
              </button>
              <div className="ai-row">
                <button className="btn-secondary" onClick={() => void copyResult()}>
                  전체 복사
                </button>
                <button className="btn-secondary" onClick={() => void exportResult("json")}>
                  JSON 받기
                </button>
              </div>
              {notice && (
                <p className="ai-notice" role="status">
                  {notice}
                </p>
              )}
              {expiry && <p className="ai-meta">{expiry}까지 다시 받을 수 있어요</p>}
            </>
          }
        >
          <ol className="ai-preview" aria-label="전체 자막" tabIndex={0}>
            {transcript.items.map((item) => (
              <li key={item.index}>
                <time>{item.time}</time>
                <span>{item.text}</span>
              </li>
            ))}
          </ol>
        </Body>
      </div>
    );
  }

  if (state.phase === "failed") {
    const code = state.errorCode ?? "";
    return (
      <div className="ai-job" aria-live="polite">
        <Head title={title} sub={facts} chip="실패" tone="bad" />
        <Body
          foot={
            <>
              {!finalErrors.has(code) && (
                <button className="btn-primary" onClick={() => setConfirming(true)}>
                  다시 시도
                </button>
              )}
              {settingsErrors.has(code) && onSettings && (
                <button className="btn-secondary" onClick={onSettings}>
                  AI 자막 설정
                </button>
              )}
            </>
          }
        >
          <div className="ai-fill">
            <p className="ai-error" role="alert">
              {errorText[code] ?? "AI 자막 생성에 실패했습니다. 다시 시도하세요."}
            </p>
          </div>
        </Body>
      </div>
    );
  }

  return (
    <div className="ai-job">
      <Head title={title} sub={facts} chip={missingShort} />
      <Body
        foot={
          <>
            <button className="btn-primary" onClick={() => setConfirming(true)}>
              AI 자막 만들기
            </button>
            {settingsButton}
          </>
        }
      >
        <div className="ai-fill">
          <p className="ai-lead">AI로 자막을 만들 수 있어요</p>
          <p className="ai-lead-sub">강의 음성으로 문장마다 시간을 붙여 드려요</p>
          <dl className="ai-facts">
            <div>
              <dt>사용 가능</dt>
              <dd>주 7회</dd>
            </div>
            <div>
              <dt>최대 강의 길이</dt>
              <dd>4시간</dd>
            </div>
          </dl>
        </div>
      </Body>
    </div>
  );
}
