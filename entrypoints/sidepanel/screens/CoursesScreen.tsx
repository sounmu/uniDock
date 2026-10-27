import { useLayoutEffect, useRef, useState } from "react";
import { ScreenHeader } from "../ui/ScreenHeader";
import {
  QueryResults,
  Refresh,
  type CourseFocus,
  type PanelModel,
} from "./QueryResults";
import { MaterialsTab } from "./MaterialsTab";
export function CoursesScreen({ model }: { readonly model: PanelModel }) {
  const heading = useRef<HTMLHeadingElement>(null);
  const [courseFocus, setCourseFocus] = useState<CourseFocus | null>(null);
  useLayoutEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, [model.selectedCourse?.courseSelector]);
  return (
    <>
      {model.course && (
        <section className="course-context">
          <button
            className="btn-ghost"
            onClick={model.showCourses}
            data-analytics-action="back"
          >
            ← 과목 선택
          </button>
          <h2 ref={heading} tabIndex={-1}>
            {model.course}
          </h2>
          <nav className="subviews" aria-label="과목 메뉴">
            {(
              [
                ["ASSIGNMENTS_LIST", "과제"],
                ["RECORDINGS_LIST", "녹화 강의"],
                ["DOCUMENTS_LIST", "강의 자료"],
              ] as const
            ).map(([type, label]) => (
              <button
                key={type}
                data-analytics-action={
                  type === "ASSIGNMENTS_LIST"
                    ? "tab_assignments"
                    : type === "RECORDINGS_LIST"
                      ? "tab_recordings"
                      : "tab_materials"
                }
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
                {label}
              </button>
            ))}
          </nav>
        </section>
      )}
      {model.view === "DOCUMENTS_LIST" ? (
        <MaterialsTab
          key={`${model.selectedCourse?.courseSelector ?? "none"}:${
            model.state.status === "success" && "documents" in model.state
              ? (model.state.documents[0]?.lmsHandle ?? "empty")
              : model.state.status
          }`}
          model={model}
        />
      ) : (
        <>
          <ScreenHeader
            title={
              model.course
                ? model.view === "RECORDINGS_LIST"
                  ? "녹화 강의"
                  : "과제"
                : "내 과목"
            }
            action={<Refresh model={model} />}
          />
          {model.course && (
            <details className="guidance">
              <summary data-analytics-action="guidance">
                {model.view === "RECORDINGS_LIST"
                  ? "강의 열기 안내"
                  : "표시 기준"}
              </summary>
              <p className="hint">
                {model.view === "RECORDINGS_LIST"
                  ? "주차학습 외부 도구와 LearningX 게시판의 KU 플레이어 영상을 표시합니다. 게시판 영상은 LMS에서 게시판을 연 뒤 약 4시간 동안 보입니다. 열린 탭에서 직접 재생하세요. LMS 재생으로 시청·출석 기록이 반영될 수 있습니다."
                  : "기본으로 미제출·잠금 해제·마감 전인 과제만 표시합니다. 실제 제출 가능 여부는 LMS에서 확인하세요."}
              </p>
            </details>
          )}
          <QueryResults
            key={model.view}
            model={model}
            courseFocus={courseFocus}
            onCourseFocus={setCourseFocus}
          />
        </>
      )}
    </>
  );
}
