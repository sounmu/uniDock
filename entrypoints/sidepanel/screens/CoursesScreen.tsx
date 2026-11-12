import { useLayoutEffect, useRef, useState } from "react";
import { ScreenHeader } from "../ui/ScreenHeader";
import {
  QueryResults,
  Refresh,
  type CourseFocus,
  type PanelModel,
} from "./QueryResults";
import { MaterialsTab } from "./MaterialsTab";
import { AssignmentFreshness, AssignmentRefresh } from "../ui/AssignmentRefresh";
const courseTabs = {
  ASSIGNMENTS_LIST: "과제",
  RECORDINGS_LIST: "녹화 강의",
  DOCUMENTS_LIST: "강의 자료",
} as const;
export function CoursesScreen({ model, onPlayback, onCaptions }: {
  readonly model: PanelModel;
  readonly onPlayback?: (handle: string) => void;
  readonly onCaptions?: (handle: string) => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const [courseFocus, setCourseFocus] = useState<CourseFocus | null>(null);
  const tab =
    model.course &&
    (model.view === "ASSIGNMENTS_LIST" ||
      model.view === "RECORDINGS_LIST" ||
      model.view === "DOCUMENTS_LIST")
      ? model.view
      : null;
  const ready =
    Boolean(model.pendingResult) ||
    (model.state.status === "success" && !("courses" in model.state));
  useLayoutEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, [model.selectedCourse?.courseSelector]);
  return (
    <>
      {model.course && (
        <section className="course-context">
          <div className="assignment-course-actions">
            <button
              className="btn-ghost"
              onClick={model.showCourses}
            >
              ← 과목 선택
            </button>
            {tab && <AssignmentRefresh model={model} label={courseTabs[tab]} />}
          </div>
          <h2 ref={heading} tabIndex={-1}>
            {model.course}
          </h2>
          <nav className="subviews assignment-course-tabs" aria-label="과목 메뉴">
            {(Object.keys(courseTabs) as (keyof typeof courseTabs)[]).map((type) => (
              <button
                key={type}
                className="btn-ghost"
                aria-pressed={model.view === type}
                onClick={() => {
                  model.setView(type);
                  if (model.selectedCourse)
                    void model.load({
                      version: 1,
                      type,
                      courseSelector: model.selectedCourse.courseSelector,
                    });
                }}
              >
                {courseTabs[type]}
              </button>
            ))}
          </nav>
        </section>
      )}
      {tab ? (
        !ready && (
          <>
            <ScreenHeader title={courseTabs[tab]} />
            <AssignmentFreshness
              updatedAt={model.updatedAt}
              pending={model.state.status === "loading"}
            />
          </>
        )
      ) : (
        <ScreenHeader title="내 과목" action={<Refresh model={model} />} />
      )}
      {model.view === "DOCUMENTS_LIST" ? (
        <MaterialsTab model={model} />
      ) : (
        <QueryResults
          key={model.view}
          model={model}
          courseFocus={courseFocus}
          onCourseFocus={setCourseFocus}
          onPlayback={onPlayback}
          onCaptions={onCaptions}
        />
      )}
    </>
  );
}
