import { PagedList } from "./PagedList";
import type { Result } from "../../src/protocol";
import { ItemResults } from "./ItemResults";
import { RecordingResults } from "./RecordingResults";
import type { AssignmentFreshnessState } from "./ui/AssignmentRefresh";
import { ListRow } from "./ui/ListRow";
import type { Course } from "../../src/domain";
export { dateLabel } from "./ItemResults";
export function ResultList({
  result,
  onCourse,
  onRecording,
  onPlayback,
  onCaptions,
  recordingPending = false,
  usedRecordingHandles,
  openedRecordingHandles,
  course = "",
  freshness,
}: {
  readonly result: Extract<Result, { status: "success" }>;
  readonly onCourse: (course: Course) => void;
  readonly onRecording?: (handle: string) => void;
  readonly onPlayback?: (handle: string) => void;
  readonly onCaptions?: (handle: string) => void;
  readonly recordingPending?: boolean;
  readonly usedRecordingHandles?: ReadonlySet<string>;
  readonly openedRecordingHandles?: ReadonlySet<string>;
  readonly course?: string;
  readonly freshness?: AssignmentFreshnessState;
}) {
  if ("opened" in result || "downloaded" in result || "documents" in result)
    return null;
  if ("recordings" in result)
    return (
      <RecordingResults
        recordings={result.recordings}
        boardsUnavailable={result.boardsUnavailable === true}
        course={course}
        onRecording={onRecording}
        onPlayback={onPlayback}
        onCaptions={onCaptions}
        recordingPending={recordingPending}
        usedRecordingHandles={usedRecordingHandles}
        openedRecordingHandles={openedRecordingHandles}
        freshness={freshness}
      />
    );
  if ("courses" in result)
    return (
      <>
        <p className="count">조회 완료 · {result.courses.length}개 과목</p>
        {result.courses.length === 0 ? (
          <div className="notice">현재 조회 가능한 과목이 없습니다.</div>
        ) : (
          <PagedList items={result.courses}>
            {(row) => (
              <li key={row.courseSelector}>
                <ListRow
                  title={row.name}
                  course="과제·녹화·자료"
                  onClick={() => onCourse(row)}
                />
              </li>
            )}
          </PagedList>
        )}
      </>
    );
  const items =
    "assignments" in result
      ? result.assignments
      : "deadlines" in result
        ? result.deadlines
        : "upcoming" in result
          ? result.upcoming
          : result.todo;
  return (
    <ItemResults
      items={items}
      deadlines={"assignments" in result || "deadlines" in result}
      todo={"todo" in result}
      course={course}
      freshness={freshness}
    />
  );
}
