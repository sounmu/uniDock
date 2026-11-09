import { useEffect, useMemo, useRef, useState } from "react";
import type { Recording } from "../../src/recordings";
import { PagedList } from "./PagedList";
import type { AssignmentFreshnessState } from "./ui/AssignmentRefresh";
import { ListRow } from "./ui/ListRow";
import { StatusChip } from "./ui/StatusChip";
import { DetailView, useDetail } from "./ui/DetailView";
import { newTab } from "./ui/a11y";
import { Icon } from "./ui/icons";
import {
  ResourceControls,
  defaultResourceFilters,
  filterResources,
  resolveResourceFilters,
} from "./ui/ResourceControls";

export function RecordingResults({
  recordings,
  boardsUnavailable,
  course,
  onRecording,
  recordingPending,
  usedRecordingHandles,
  openedRecordingHandles,
  freshness,
}: {
  readonly recordings: readonly Recording[];
  readonly boardsUnavailable: boolean;
  readonly course: string;
  readonly onRecording?: (handle: string) => void;
  readonly recordingPending: boolean;
  readonly usedRecordingHandles?: ReadonlySet<string>;
  readonly openedRecordingHandles?: ReadonlySet<string>;
  readonly freshness?: AssignmentFreshnessState;
}) {
  const [filters, setFilters] = useState(defaultResourceFilters);
  const applied = resolveResourceFilters(recordings, filters);
  const visible = useMemo(
    () => filterResources(recordings, applied),
    [recordings, applied],
  );
  const { detail, open, back } = useDetail<Recording>();
  const previous = useRef(recordings);
  useEffect(() => {
    if (previous.current === recordings) return;
    previous.current = recordings;
    if (detail) back();
  }, [recordings, detail, back]);
  return (
    <>
      <div hidden={detail !== null}>
        <ResourceControls
          kind="recordings"
          items={recordings}
          filters={applied}
          onApply={setFilters}
          freshness={freshness}
        />
        {boardsUnavailable && (
          <div className="notice" role="status">
            게시판 영상을 불러오지 못해 주차학습 녹화 강의만 표시합니다. 잠시
            후 새로고침해 보세요.
          </div>
        )}
        {visible.length === 0 ? (
          <div className="notice">
            {recordings.length === 0
              ? "조회 가능한 녹화 강의 후보가 없습니다."
              : "조건에 맞는 녹화 강의가 없습니다."}
          </div>
        ) : (
          <PagedList items={visible}>
            {(row) => (
              <li key={row.lmsHandle} className="action-row">
                <ListRow
                  title={row.title}
                  course={row.module || course}
                  chip={
                    !row.launchHandle ? (
                      <StatusChip>LMS에서 확인</StatusChip>
                    ) : row.source === "board" ? (
                      <StatusChip>게시판 영상</StatusChip>
                    ) : undefined
                  }
                  onClick={() => open(row)}
                />
                {row.launchHandle && (
                  <RowLaunch
                    title={row.title}
                    state={
                      openedRecordingHandles?.has(row.launchHandle)
                        ? "opened"
                        : usedRecordingHandles?.has(row.launchHandle)
                          ? "expired"
                          : "ready"
                    }
                    disabled={!onRecording || recordingPending}
                    onClick={() => onRecording?.(row.launchHandle)}
                  />
                )}
              </li>
            )}
          </PagedList>
        )}
      </div>
      {detail && (
        <DetailView
          title={detail.title}
          onBack={back}
          meta={[
            [
              detail.source === "board" ? "출처" : "모듈",
              detail.module || "모듈 이름 없음",
            ],
            [
              "설명",
              detail.source === "board"
                ? "게시판의 강의 플레이어를 새 탭에서 엽니다."
                : detail.launchHandle
                  ? "LMS를 거쳐 강의 플레이어를 새 탭에서 엽니다."
                  : "개별 항목 주소를 확인할 수 없습니다. LMS 모듈에서 열어주세요.",
            ],
          ]}
        >
          <div className="tools">
            <button
              className="btn-primary"
              disabled={
                !detail.launchHandle ||
                !onRecording ||
                recordingPending ||
                usedRecordingHandles?.has(detail.launchHandle)
              }
              onClick={() => onRecording?.(detail.launchHandle)}
              {...newTab("강의 열기")}
            />
            <button
              className="btn-secondary"
              disabled={
                !onRecording ||
                recordingPending ||
                usedRecordingHandles?.has(detail.lmsHandle)
              }
              onClick={() => onRecording?.(detail.lmsHandle)}
              {...newTab(
                detail.source === "board"
                  ? "LMS 게시판에서 보기"
                  : "LMS 모듈에서 보기",
              )}
            />
          </div>
        </DetailView>
      )}
    </>
  );
}
// A sibling of the row button, since buttons cannot nest. Launch handles are
// one-use: a consumed row says whether it opened or now needs a fresh list
// (expired, timed out or failed to open), instead of looking merely disabled.
function RowLaunch({
  title,
  state,
  disabled,
  onClick,
}: {
  readonly title: string;
  readonly state: "ready" | "opened" | "expired";
  readonly disabled: boolean;
  readonly onClick: () => void;
}) {
  const name = title || "제목 없음";
  const label = {
    ready: "강의 열기",
    opened: "열었음",
    expired: "새로고침 필요",
  }[state];
  return (
    <button
      className={`row-action${state === "ready" ? "" : ` ${state}`}`}
      disabled={state !== "ready" || disabled}
      onClick={onClick}
      aria-label={
        state === "ready"
          ? `${name} 강의 열기 (새 탭)`
          : state === "opened"
            ? `${name} 강의 열었음`
            : `${name} 강의 열 수 없음, 목록을 새로고침하세요`
      }
    >
      {label}
      {state === "ready" && (
        <>
          {" "}
          <Icon name="external" />
        </>
      )}
    </button>
  );
}
