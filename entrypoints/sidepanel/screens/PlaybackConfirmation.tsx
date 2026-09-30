import type { PlaybackModel } from "../usePlaybackPanel";

export function PlaybackConfirmation({
  model: m,
  onComplete,
}: {
  readonly model: PlaybackModel;
  readonly onComplete?: () => void;
}) {
  const selected = m.recordings
    .filter((item) => item.order !== null)
    .sort((a, b) => a.order! - b.order!);
  return (
    <>
      <p className="hint">
        체크한 순서대로 바로 재생합니다. 재생 중에는 전용 강의 탭을 활성 상태로
        유지하세요.
      </p>
      <label className="field">
        과목 선택
        <select
          value={m.course}
          disabled={m.pending}
          onChange={(event) => m.setCourse(event.target.value)}
        >
          <option value="">과목 선택</option>
          {m.courses.map((item) => (
            <option key={item.courseSelector} value={item.courseSelector}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      <button
        className="btn-secondary"
        disabled={m.pending || !m.course}
        onClick={() => void m.loadRecordings()}
      >
        영상 불러오기
      </button>
      <ul className="playback-selection">
        {m.recordings.map((item) => (
          <li key={item.lmsHandle}>
            <label className="playback-choice">
              <input
                type="checkbox"
                checked={item.order !== null}
                disabled={
                  m.pending ||
                  !item.launchHandle ||
                  (item.order === null && selected.length >= 100)
                }
                onChange={(event) =>
                  m.selectRecording(item.launchHandle, event.target.checked)
                }
              />
              <span className="playback-order" aria-hidden="true">
                {item.order ?? ""}
              </span>
              <span>
                <strong>{item.title}</strong>
                <small>{item.module}</small>
              </span>
            </label>
            {!item.launchHandle && (
              <p>영상 항목을 확인할 수 없어 자동 재생할 수 없습니다.</p>
            )}
          </li>
        ))}
      </ul>
      <div className="notice">
        <p>선택한 {selected.length}개 영상을 표시된 순서대로 재생합니다.</p>
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
          disabled={m.pending || selected.length === 0 || selected.length > 100}
          onClick={() =>
            void m.startSelected().then((ok) => {
              if (ok) onComplete?.();
            })
          }
        >
          자동 재생
        </button>
      </div>
    </>
  );
}
