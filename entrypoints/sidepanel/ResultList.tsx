import { PagedList } from "./PagedList";
import { type Result } from "../../src/protocol";
import { ItemResults } from "./ItemResults";
export { dateLabel } from "./ItemResults";
export function ResultList({
  result,
  onCourse,
  onRecording,
  onRecordings,
  recordingPending = false,
  usedRecordingHandles,
}: {
  result: Extract<Result, { status: "success" }>;
  onCourse: (name: string) => void;
  onRecording?: (handle: string) => void;
  onRecordings?: (name: string) => void;
  recordingPending?: boolean;
  usedRecordingHandles?: ReadonlySet<string>;
}) {
  if ("opened" in result)
    return <div className="notice">새 LMS/LTI 탭을 열었습니다.</div>;
  if ("recordings" in result)
    return (
      <>
        <p className="count">
          조회 완료 · {result.recordings.length}개 강의 후보
        </p>
        {result.recordings.length === 0 ? (
          <div className="notice">조회 가능한 녹화 강의 후보가 없습니다.</div>
        ) : (
          <PagedList items={result.recordings}>
            {(item) => (
              <li key={item.lmsHandle}>
                <div className="item-body">
                  <p>{item.module || "모듈 이름 없음"}</p>
                  <strong>{item.title || "제목 없음"}</strong>
                  <div className="recording-actions">
                    <button
                      className="secondary"
                      disabled={
                        !onRecording ||
                        recordingPending ||
                        usedRecordingHandles?.has(item.lmsHandle)
                      }
                      onClick={() => onRecording?.(item.lmsHandle)}
                    >
                      LMS에서 보기 ↗
                    </button>
                    <button
                      disabled={
                        !item.launchHandle ||
                        !onRecording ||
                        recordingPending ||
                        usedRecordingHandles?.has(item.launchHandle)
                      }
                      onClick={() => onRecording?.(item.launchHandle)}
                    >
                      LTI 탭 열기 ↗
                    </button>
                  </div>
                  {!item.launchHandle && (
                    <p>
                      개별 항목 주소를 확인할 수 없습니다. LMS 모듈에서
                      열어주세요.
                    </p>
                  )}
                </div>
              </li>
            )}
          </PagedList>
        )}
      </>
    );
  if ("courses" in result)
    return (
      <>
        <p className="count">조회 완료 · {result.courses.length}개 과목</p>
        {result.courses.length === 0 ? (
          <div className="notice">현재 조회 가능한 과목이 없습니다.</div>
        ) : (
          <PagedList items={result.courses}>
            {(course, index) => (
              <li key={index}>
                <div className="item-body">
                  <strong>{course.name}</strong>
                  <div className="recording-actions">
                    <button
                      className="secondary"
                      onClick={() => onCourse(course.name)}
                    >
                      과제 보기
                    </button>
                    {onRecordings && (
                      <button
                        className="secondary"
                        onClick={() => onRecordings(course.name)}
                      >
                        녹화 보기
                      </button>
                    )}
                  </div>
                </div>
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
    />
  );
}
