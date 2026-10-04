import { ScreenHeader } from "../ui/ScreenHeader";
import { QueryResults, Refresh, type PanelModel } from "./QueryResults";
export function TasksScreen({ model }: { readonly model: PanelModel }) {
  return (
    <>
      <ScreenHeader title="할 일·일정" action={<Refresh model={model} />} />
      <nav className="subviews" aria-label="할 일·일정 메뉴">
        {(
          [
            ["TODO_LIST", "할 일"],
            ["UPCOMING_LIST", "일정"],
          ] as const
        ).map(([type, label]) => (
          <button
            key={type}
            data-analytics-action="tasks_mode"
            className="btn-ghost"
            aria-pressed={model.view === type}
            onClick={() => {
              model.setView(type);
              void model.load(
                type === "TODO_LIST"
                  ? { version: 1, type }
                  : {
                      version: 1,
                      type,
                      ...(model.start ? { start_date: model.start } : {}),
                      ...(model.end ? { end_date: model.end } : {}),
                    },
              );
            }}
          >
            {label}
          </button>
        ))}
      </nav>
      {model.tasksMode === "todo" ? (
        <details className="guidance">
          <summary data-analytics-action="guidance">안내</summary>
          <p className="hint">
            현재 수강 중인 모든 과목의 미제출 과제를 표시합니다. 마감 없음·지난
            과제도 포함합니다.
          </p>
        </details>
      ) : (
        <details className="view-settings">
          <summary data-analytics-action="view_options">보기 설정</summary>
          <div className="view-settings-body date-fields">
            <label className="field">
              시작일 (선택)
              <input
                type="date"
                value={model.start}
                data-analytics-action="date_start"
                onChange={(e) => {
                  model.clear();
                  model.setStart(e.target.value);
                }}
              />
            </label>
            <label className="field">
              종료일 (선택)
              <input
                type="date"
                value={model.end}
                data-analytics-action="date_end"
                onChange={(e) => {
                  model.clear();
                  model.setEnd(e.target.value);
                }}
              />
            </label>
          </div>
        </details>
      )}
      {model.start &&
        model.end &&
        model.start > model.end &&
        model.tasksMode === "upcoming" && (
          <p role="alert">종료일은 시작일 이후여야 합니다.</p>
        )}
      <QueryResults key={model.view} model={model} />
    </>
  );
}
