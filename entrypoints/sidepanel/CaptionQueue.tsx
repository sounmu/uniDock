import { useMemo, useRef } from "react";
import type { Recording } from "../../src/recordings";
import { QueryGate } from "./query-gate";
import { useRecordingPicker, type RecordingEntry } from "./useRecordingPicker";
import { useCaptionQueue, type QueueItem } from "./useCaptionQueue";
import { useCaptionSession } from "./useCaptionSession";
import { remainingJobs, useCaptionAccount } from "./useCaptionAccount";
import { RecordingPicker } from "./screens/RecordingPicker";
import { DetailView } from "./ui/DetailView";
import { Notice } from "./ui/Notice";
import { StatusChip } from "./ui/StatusChip";
import { errorText } from "./AiCaptionsSection";

const eligible = (item: Recording) => Boolean(item.launchHandle);
const reason = (item: Recording) =>
  item.launchHandle ? null : "영상 항목을 확인할 수 없어 선택할 수 없습니다.";

const phaseLabel: Record<string, string> = {
  waiting: "차례 기다리는 중",
  opening: "강의 여는 중",
  identifying: "영상 찾는 중",
  extracting: "음성 준비 중",
  uploading: "음성 보내는 중",
  queued: "대기열에 있어요",
  running: "자막 만드는 중",
  succeeded: "완료",
  cancelled: "멈춤",
  failed: "실패",
};

function failure(item: QueueItem): string {
  return (item.errorCode && errorText[item.errorCode]) || "자막을 만들지 못했습니다. 다시 시도하세요.";
}

export function CaptionQueue({
  entry,
  picking,
  onPick,
  onBack,
  onSettings,
}: {
  readonly entry?: RecordingEntry;
  readonly picking: boolean;
  readonly onPick: () => void;
  readonly onBack: () => void;
  readonly onSettings?: () => void;
}) {
  const gate = useRef(new QueryGate()).current;
  const queue = useCaptionQueue();
  const session = useCaptionSession();
  // The account is read again when a job takes a use and when a cancelled or
  // failed one gives it back.
  const usage = queue.items
    .filter((item) => item.jobId !== null)
    .map((item) => `${item.jobId}:${item.phase === "failed" || item.phase === "cancelled" ? "released" : "held"}`)
    .join(",");
  const account = useCaptionAccount(session, usage);
  const remaining = account ? remainingJobs(account) : null;
  const options = useMemo(
    () => ({ eligible, limit: remaining ?? 7 }),
    [remaining],
  );
  const picker = useRecordingPicker(gate, options, entry);
  const selected = picker.recordings.filter((item) => item.order !== null).length;
  const done = queue.items.length > 0 && !queue.running;

  function start() {
    const titles = new Map(picker.recordings.map((item) => [item.launchHandle, item.title]));
    const selection = picker.takeSelection();
    if (!selection) return;
    void queue.start(selection, (handle) => titles.get(handle) ?? "강의");
    onBack();
  }

  if (picking)
    return (
      <DetailView title="강의 고르기" onBack={onBack}>
        <RecordingPicker
          model={picker}
          busy={picker.loading || queue.running}
          loading={picker.loading}
          max={options.limit}
          reason={reason}
        >
          <details className="playback-selection-help">
            <summary>만드는 방법</summary>
            <p className="hint">
              고른 순서대로 강의를 한 탭에서 하나씩 열어 음성을 보냅니다. 보낸 뒤에는
              서버에서 차례로 자막을 만들고, 완성된 자막은 그 강의를 다시 열면
              자막 추출과 영상 자막에서 볼 수 있습니다.
            </p>
          </details>
          <div className="playback-selection-actions">
            <div role="status" aria-live="polite" aria-atomic="true">
              <strong>{selected}개 선택</strong>
              <small>
                {remaining === null ? "하루 7회" : `오늘 남은 횟수 ${remaining}회`}
              </small>
            </div>
            <button
              className="btn-primary"
              disabled={selected === 0 || queue.running || remaining === 0}
              onClick={start}
            >
              AI 자막 만들기
            </button>
          </div>
        </RecordingPicker>
        {picker.error && <Notice error>{picker.error}</Notice>}
      </DetailView>
    );

  return (
    <section className="caption-queue" aria-label="여러 강의 AI 자막">
      <div className="caption-queue-head">
        <div>
          <h3>여러 강의 AI 자막</h3>
          <p className="hint">
            {session === null
              ? "Google 계정으로 로그인하면 여러 강의를 골라 한 번에 만들 수 있어요."
              : remaining === null
                ? "강의를 골라 차례로 자막을 만들어요. 하루 7회까지 쓸 수 있어요."
                : `강의를 골라 차례로 자막을 만들어요. 오늘 남은 횟수 ${remaining}회`}
          </p>
        </div>
        {session === null ? (
          <button className="btn-secondary" onClick={onSettings}>로그인</button>
        ) : queue.running ? (
          <button className="btn-secondary" onClick={queue.stop}>멈추기</button>
        ) : (
          <button
            className="btn-secondary"
            disabled={!session || remaining === 0}
            onClick={() => {
              queue.clear();
              onPick();
              if (!entry) void picker.loadCourses();
            }}
          >
            강의 고르기
          </button>
        )}
      </div>
      {queue.items.length > 0 && (
        <ul className="caption-queue-list" aria-live="polite">
          {queue.items.map((item) => (
            <li key={item.handle}>
              <strong title={item.title}>{item.title}</strong>
              <StatusChip urgent={item.phase === "failed"} done={item.phase === "succeeded"}>
                {phaseLabel[item.phase] ?? ""}
              </StatusChip>
              {item.phase === "failed" && <p>{failure(item)}</p>}
            </li>
          ))}
        </ul>
      )}
      {done && (
        <p className="hint">
          완성된 자막은 강의를 열고 자막 추출을 누르거나 영상에서 바로 볼 수 있어요.
        </p>
      )}
    </section>
  );
}
