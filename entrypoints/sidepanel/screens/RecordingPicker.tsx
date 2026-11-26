import { useId, useState, type ReactNode } from "react";
import type { Recording } from "../../../src/recordings";
import type { Course } from "../../../src/domain";
import { courseFolderName } from "../../../src/security/download";
import type { RecordingDraft } from "../useRecordingPicker";
import { Select } from "../ui/Select";
import { Icon } from "../ui/icons";

/** Placeholder group shaped like the loaded choices: a module heading, then
    rows with a checkbox and one title line. */
function ChoiceSkeleton() {
  return (
    <div className="playback-selection-group" aria-hidden="true">
      <p className="skeleton-heading">{"\u00a0"}</p>
      <ul className="playback-selection">
        {[0, 1, 2, 3, 4, 5].map((row) => (
          <li key={row} className="skeleton-choice">
            <span />
            <span />
          </li>
        ))}
      </ul>
    </div>
  );
}

export interface PickerModel {
  readonly courses: readonly Course[];
  readonly course: string;
  readonly setCourse: (value: string) => void;
  readonly loadRecordings: () => Promise<void>;
  readonly recordings: readonly RecordingDraft[];
  readonly selectRecording: (handle: string, selected: boolean) => void;
  readonly error: string;
}

export function RecordingPicker({
  model: m,
  busy,
  loading,
  max,
  reason,
  children,
}: {
  readonly model: PickerModel;
  readonly busy: boolean;
  readonly loading: boolean;
  readonly max: number;
  readonly reason: (item: Recording) => string | null;
  readonly children: ReactNode;
}) {
  const courseId = useId();
  const [search, setSearch] = useState("");
  const selectedCount = m.recordings.filter((item) => item.order !== null).length;
  const groups = new Map<string, RecordingDraft[]>();
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
            disabled={busy}
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
            className={`btn-secondary assignment-refresh${busy ? " is-loading" : ""}`}
            aria-label="영상 불러오기"
            title="영상 목록 새로고침"
            aria-busy={busy}
            disabled={busy || !m.course}
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
        disabled={!m.course || busy}
        onChange={(event) => setSearch(event.target.value)}
      />
      <div className="playback-selection-groups" aria-busy={busy}>
        {loading ? <ChoiceSkeleton /> : [...groups].map(([module, items], index) => (
          <section className="playback-selection-group" key={module}
            aria-labelledby={`${courseId}-group-${index}`}>
            <h3 id={`${courseId}-group-${index}`}>{module}</h3>
            <ul className="playback-selection">
              {items.map((item) => {
                const why = reason(item);
                return (
                  <li key={item.lmsHandle}>
                    <label className="playback-choice">
                      <input
                        type="checkbox"
                        aria-label={item.title}
                        aria-describedby={why ? `${courseId}-${item.lmsHandle}-reason` : undefined}
                        checked={item.order !== null}
                        disabled={busy || why !== null ||
                          (item.order === null && selectedCount >= max)}
                        onChange={(event) => m.selectRecording(item.launchHandle, event.target.checked)}
                      />
                      <strong title={item.title}>{item.title}</strong>
                      <span className="playback-order" aria-hidden="true">{item.order ?? ""}</span>
                    </label>
                    {why && <p id={`${courseId}-${item.lmsHandle}-reason`}>{why}</p>}
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
        {!busy && !m.error && groups.size === 0 && (
          <p className="hint">
            {!m.course ? "과목을 선택하면 강의 목록이 표시됩니다."
              : m.recordings.length ? "검색 결과가 없습니다." : "선택할 강의가 없습니다."}
          </p>
        )}
      </div>
      {children}
    </div>
  );
}
