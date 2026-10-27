import { useLayoutEffect, useRef, useState } from "react";
import type { Course } from "../../../src/domain";
import { ResultList } from "../ResultList";
import type { useSidepanelQuery } from "../useSidepanelQuery";
import { messages } from "../query-messages";
import { Notice } from "../ui/Notice";
import { restoreFocus, softDisabled } from "../ui/a11y";
import { ListRow } from "../ui/ListRow";
export type PanelModel = ReturnType<typeof useSidepanelQuery>;
export type CourseFocus = {
  readonly courseSelector: string;
  readonly name: string;
  readonly occurrence: number;
};
export function QueryResults({
  model,
  courseFocus = null,
  onCourseFocus,
}: {
  readonly model: PanelModel;
  readonly courseFocus?: CourseFocus | null;
  readonly onCourseFocus?: (focus: CourseFocus | null) => void;
}) {
  const { state, recordingAction } = model;
  const selectCourse = (course: Course) => {
    model.setCourse(course);
    model.setView("ASSIGNMENTS_LIST");
    void model.load({
      version: 1,
      type: "ASSIGNMENTS_LIST",
      courseSelector: course.courseSelector,
    });
  };
  return (
    <section
      aria-live="polite"
      aria-busy={state.status === "loading" || recordingAction.pending}
    >
      {recordingAction.notice && <Notice>{recordingAction.notice}</Notice>}
      {state.status === "idle" && (
        <Notice>
          LMS 탭을 선택하고 새로고침을 누르세요. 과목을 선택하면
          과제·녹화·자료를 확인할 수 있습니다.
        </Notice>
      )}
      {state.status === "loading" && (
        <>
          <Notice>목록을 불러오고 있습니다…</Notice>
          <Skeleton />
        </>
      )}
      {state.status === "error" && (
        <Notice error>
          <strong>
            {state.code === "LOGIN_REQUIRED" ? "로그인 필요" : "조회 안내"}
          </strong>
          <p>{messages[state.code]}</p>
        </Notice>
      )}
      {state.status === "success" && "courses" in state ? (
        <CourseResults
          courses={state.courses}
          focus={courseFocus}
          onRestored={() => onCourseFocus?.(null)}
          onCourse={(course, index) => {
            onCourseFocus?.({
              courseSelector: course.courseSelector,
              name: course.name,
              occurrence: state.courses
                .slice(0, index)
                .filter((row) => row.name === course.name).length,
            });
            selectCourse(course);
          }}
        />
      ) : state.status === "success" ? (
        <ResultList
          result={state}
          course={model.course}
          onCourse={selectCourse}
          onRecording={(handle) => void model.openRecording(handle)}
          recordingPending={recordingAction.pending}
          usedRecordingHandles={recordingAction.used}
          openedRecordingHandles={recordingAction.opened}
        />
      ) : null}
    </section>
  );
}
function CourseResults({
  courses,
  focus,
  onRestored,
  onCourse,
}: {
  readonly courses: readonly Course[];
  readonly focus: CourseFocus | null;
  readonly onRestored: () => void;
  readonly onCourse: (course: Course, index: number) => void;
}) {
  // Selectors are response-scoped. A refreshed list needs a name/occurrence
  // fallback, including separate controls for courses with identical names.
  const [origin] = useState(() => {
    if (!focus) return -1;
    const exact = courses.findIndex(
      (course) => course.courseSelector === focus.courseSelector,
    );
    if (exact !== -1) return exact;
    return (
      courses
        .map((course, index) => ({ course, index }))
        .filter(({ course }) => course.name === focus.name)[focus.occurrence]
        ?.index ?? -1
    );
  });
  const [page, setPage] = useState(Math.max(0, Math.floor(origin / 100)));
  const trigger = useRef<HTMLLIElement>(null);
  useLayoutEffect(() => {
    if (!focus) return;
    restoreFocus(trigger.current?.querySelector("button") ?? null);
    onRestored();
  }, [focus, onRestored]);
  const start = page * 100;
  const end = Math.min(start + 100, courses.length);
  return (
    <>
      <p className="count">조회 완료 · {courses.length}개 과목</p>
      {courses.length === 0 ? (
        <div className="notice">현재 조회 가능한 과목이 없습니다.</div>
      ) : (
        <>
          {courses.length > 100 && (
            <nav className="pagination" aria-label="목록 페이지">
              <button
                className="btn-secondary"
                data-analytics-action="page_previous"
                {...softDisabled(page === 0, () => setPage(page - 1))}
              >
                이전
              </button>
              <span aria-live="polite">
                {start + 1}–{end} / {courses.length}개
              </span>
              <button
                className="btn-secondary"
                data-analytics-action="page_next"
                {...softDisabled(end === courses.length, () =>
                  setPage(page + 1),
                )}
              >
                다음
              </button>
            </nav>
          )}
          <ul>
            {courses.slice(start, end).map((course, index) => (
              <li
                key={course.courseSelector}
                ref={start + index === origin ? trigger : undefined}
              >
                <ListRow
                  title={course.name}
                  analyticsAction="course_select"
                  course="과제·녹화·자료"
                  onClick={() => onCourse(course, start + index)}
                />
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
export function Skeleton() {
  return (
    <ul aria-hidden="true">
      {[0, 1, 2, 3, 4, 5].map((row) => (
        <li key={row} className="skeleton-row">
          <span />
          <span />
        </li>
      ))}
    </ul>
  );
}
export function Refresh({ model }: { readonly model: PanelModel }) {
  return (
    <button
      className="btn-primary"
      data-analytics-action="refresh"
      {...softDisabled(
        model.state.status === "loading" || !model.isQueryValid,
        () => void model.load(model.query, { refresh: true }),
      )}
    >
      {model.state.status === "loading" ? "조회 중…" : "새로고침"}
    </button>
  );
}
