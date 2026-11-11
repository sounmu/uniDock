import type { PlaybackModel } from "../usePlaybackPanel";
import { useId, useState } from "react";
import { Select } from "../ui/Select";
import { Icon } from "../ui/icons";
import { courseFolderName } from "../../../src/security/download";
import { Skeleton } from "./QueryResults";

export function PlaybackConfirmation({
  model: m,
  onComplete,
}: {
  readonly model: PlaybackModel;
  readonly onComplete?: () => void;
}) {
  const courseId = useId();
  const [search, setSearch] = useState("");
  const selectedCount = m.recordings.filter((item) => item.order !== null).length;
  const groups = new Map<string, typeof m.recordings>();
  const term = search.trim().toLocaleLowerCase();
  for (const item of m.recordings) {
    if (term && !item.title.toLocaleLowerCase().includes(term)) continue;
    const module = item.module || "기타 강의";
    const group = groups.get(module);
    if (group) group.push(item);
    else groups.set(module, [item]);
  }
  return (
    <div className="playback-picker">
      <div className="field">
        <label htmlFor={courseId}>과목 선택</label>
        <div className="playback-course-select">
          <Select
            id={courseId}
            value={m.course}
            disabled={m.pending}
            onChange={(event) => {
              setSearch("");
              m.setCourse(event.target.value);
            }}
          >
            <option value="">과목 선택</option>
            {m.courses.map((item) => (
              <option key={item.courseSelector} value={item.courseSelector}>
                {courseFolderName(item.name)}
              </option>
            ))}
          </Select>
          <button
            className={`btn-secondary assignment-refresh${m.pending ? " is-loading" : ""}`}
            aria-label="영상 불러오기"
            title="영상 목록 새로고침"
            aria-busy={m.pending}
            disabled={m.pending || !m.course}
            onClick={() => void m.loadRecordings()}
          >
            <Icon name="refresh" />
          </button>
        </div>
      </div>
      <input
        className="playback-search"
        type="search"
        aria-label="강의 검색"
        placeholder="강의 제목 검색"
        value={search}
        disabled={!m.course || m.pending}
        onChange={(event) => setSearch(event.target.value)}
      />
      <div className="playback-selection-groups" aria-busy={m.pending}>
        {m.pending && !m.startPending ? <Skeleton /> : [...groups].map(([module, items], index) => (
          <section className="playback-selection-group" key={module}
            aria-labelledby={`${courseId}-group-${index}`}>
            <h3 id={`${courseId}-group-${index}`}>{module}</h3>
            <ul className="playback-selection">
              {items.map((item) => {
                const reason = !item.launchHandle
                  ? "영상 항목을 확인할 수 없어 자동 재생할 수 없습니다."
                  : item.source === "board"
                    ? "게시판 영상은 LMS 모듈 항목이 아니라 자동 재생에서 제외됩니다."
                    : null;
                return (
                  <li key={item.lmsHandle}>
                    <label className="playback-choice">
                      <input
                        type="checkbox"
                        aria-label={item.title}
                        aria-describedby={reason ? `${courseId}-${item.lmsHandle}-reason` : undefined}
                        checked={item.order !== null}
                        disabled={m.pending || reason !== null ||
                          (item.order === null && selectedCount >= 100)}
                        onChange={(event) => m.selectRecording(item.launchHandle, event.target.checked)}
                      />
                      <strong title={item.title}>{item.title}</strong>
                      <span className="playback-order" aria-hidden="true">{item.order ?? ""}</span>
                    </label>
                    {reason && <p id={`${courseId}-${item.lmsHandle}-reason`}>{reason}</p>}
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
        {!m.pending && !m.error && groups.size === 0 && (
          <p className="hint">
            {!m.course ? "과목을 선택하면 강의 목록이 표시됩니다."
              : m.recordings.length ? "검색 결과가 없습니다." : "선택할 강의가 없습니다."}
          </p>
        )}
      </div>
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
    </div>
  );
}
