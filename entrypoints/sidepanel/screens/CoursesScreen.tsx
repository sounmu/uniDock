import { ScreenHeader } from "../ui/ScreenHeader";
import { QueryResults, Refresh, type PanelModel } from "./QueryResults";
import { MaterialsTab } from "./MaterialsTab";
export function CoursesScreen({ model }: { readonly model: PanelModel }) {
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
          <h2>{model.course}</h2>
          <nav className="subviews" aria-label="과목 메뉴">
            {(
              [
                ["ASSIGNMENTS_LIST", "과제"],
                ["RECORDINGS_LIST", "녹화 강의"],
                ["DOCUMENTS_LIST", "수업 자료"],
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
              <summary data-analytics-action="guidance">안내</summary>
              <p className="hint">
                {model.view === "RECORDINGS_LIST"
                  ? "외부 도구 항목 중 녹화 강의 후보를 표시합니다. LTI 탭은 LMS를 거쳐 열립니다. 재생은 열린 LMS에서 직접 조작하세요. LMS 자체 재생으로 시청·출석 기록이 반영될 수 있습니다."
                  : "기본값은 남은 과제 후보만 표시합니다. ‘남은 후보’는 미제출·잠금 해제·미래 마감 기준이며 실제 제출 가능 여부는 LMS에서 확인하세요."}
              </p>
            </details>
          )}
          <QueryResults key={model.view} model={model} />
        </>
      )}
    </>
  );
}
