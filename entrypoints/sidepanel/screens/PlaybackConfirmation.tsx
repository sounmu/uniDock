import type { Recording } from "../../../src/recordings";
import type { PlaybackModel } from "../usePlaybackPanel";
import { RecordingPicker } from "./RecordingPicker";

function playbackReason(item: Recording): string | null {
  if (!item.launchHandle) return "영상 항목을 확인할 수 없어 자동 재생할 수 없습니다.";
  return item.source === "board"
    ? "게시판 영상은 LMS 모듈 항목이 아니라 자동 재생에서 제외됩니다."
    : null;
}

export function PlaybackConfirmation({
  model: m,
  onComplete,
}: {
  readonly model: PlaybackModel;
  readonly onComplete?: () => void;
}) {
  const selectedCount = m.recordings.filter((item) => item.order !== null).length;
  return (
    <RecordingPicker
      model={m}
      busy={m.pending}
      loading={m.pending && !m.startPending}
      max={100}
      reason={playbackReason}
    >
      <details className="playback-selection-help">
        <summary>재생 안내</summary>
        <p className="hint">
          체크한 순서대로 바로 재생합니다. 다른 탭으로 이동해도 확장이 재생을
          멈추지 않으며, 강의 플레이어에서 일시정지·재개할 수 있습니다.
          한 번에 최대 100개를 선택할 수 있습니다.
        </p>
      </details>
      <div className="playback-selection-actions">
        <div role="status" aria-live="polite" aria-atomic="true">
          <strong>{m.startPending ? "재생 준비 중" : `${selectedCount}개 선택`}</strong>
          <small>선택한 순서대로 재생</small>
        </div>
        {m.startPending && (
          <button
            className="btn-secondary"
            disabled={m.stopPending}
            onClick={() =>
              void m.run({ version: 1, type: "PLAYBACK_STOP_ALL" })
            }
          >
            자동 재생 끄기
          </button>
        )}
        <button
          className="btn-primary"
          disabled={m.pending || selectedCount === 0 || selectedCount > 100}
          onClick={() =>
            void m.startSelected().then((ok) => {
              if (ok) onComplete?.();
            })
          }
        >
          자동 재생
        </button>
      </div>
    </RecordingPicker>
  );
}
