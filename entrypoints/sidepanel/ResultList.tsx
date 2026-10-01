import { PagedList } from "./PagedList";
import type { Result } from "../../src/protocol";
import { ItemResults } from "./ItemResults";
import { ListRow } from "./ui/ListRow";
import { StatusChip } from "./ui/StatusChip";
import { DetailView, useDetail } from "./ui/DetailView";
import type { Course } from "../../src/domain";
export { dateLabel } from "./ItemResults";
export function ResultList({
  result,
  onCourse,
  onRecording,
  recordingPending = false,
  usedRecordingHandles,
  course = "",
}: {
  readonly result: Extract<Result, { status: "success" }>;
  readonly onCourse: (course: Course) => void;
  readonly onRecording?: (handle: string) => void;
  readonly recordingPending?: boolean;
  readonly usedRecordingHandles?: ReadonlySet<string>;
  readonly course?: string;
}) {
  const { detail, open, back } = useDetail<number>();
  if ("opened" in result || "downloaded" in result || "documents" in result)
    return null;
  if ("recordings" in result) {
    const item = detail === null ? undefined : result.recordings[detail];
    return (
      <>
        <div hidden={item !== undefined}>
          <p className="count">
            조회 완료 · {result.recordings.length}개 강의 후보
          </p>
          {result.recordings.length === 0 ? (
            <div className="notice">조회 가능한 녹화 강의 후보가 없습니다.</div>
          ) : (
            <PagedList items={result.recordings}>
              {(row, index) => (
                <li key={row.lmsHandle}>
                  <ListRow
                    title={row.title}
                    course={course || row.module}
                    chip={
                      <StatusChip>
                        {row.launchHandle ? "LTI 열기 가능" : "LMS에서 확인"}
                      </StatusChip>
                    }
                    onClick={() => open(index)}
                  />
                </li>
              )}
            </PagedList>
          )}
        </div>
        {item && (
          <DetailView
            title={item.title}
            onBack={back}
            meta={[
              ["모듈", item.module || "모듈 이름 없음"],
              [
                "설명",
                item.launchHandle
                  ? "LTI 탭은 LMS를 거쳐 열립니다."
                  : "개별 항목 주소를 확인할 수 없습니다. LMS 모듈에서 열어주세요.",
              ],
            ]}
          >
            <div className="tools">
              <button
                className="btn-primary"
                disabled={
                  !item.launchHandle ||
                  !onRecording ||
                  recordingPending ||
                  usedRecordingHandles?.has(item.launchHandle)
                }
                data-analytics-action="recording_launch"
                onClick={() => onRecording?.(item.launchHandle)}
              >
                LTI 탭 열기 ↗
              </button>
              <button
                className="btn-secondary"
                disabled={
                  !onRecording ||
                  recordingPending ||
                  usedRecordingHandles?.has(item.lmsHandle)
                }
                data-analytics-action="recording_module"
                onClick={() => onRecording?.(item.lmsHandle)}
              >
                LMS 모듈에서 보기 ↗
              </button>
            </div>
          </DetailView>
        )}
      </>
    );
  }
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
                  analyticsAction="course_select"
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
    />
  );
}
