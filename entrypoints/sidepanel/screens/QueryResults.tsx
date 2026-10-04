import { ResultList } from "../ResultList";
import type { useSidepanelQuery } from "../useSidepanelQuery";
import { messages } from "../query-messages";
import { Notice } from "../ui/Notice";
import { softDisabled } from "../ui/a11y";
export type PanelModel = ReturnType<typeof useSidepanelQuery>;
export function QueryResults({ model }: { readonly model: PanelModel }) {
  const { state, recordingAction } = model;
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
      {state.status === "success" && (
        <ResultList
          result={state}
          course={model.course}
          onCourse={(course) => {
            model.setCourse(course);
            model.setView("ASSIGNMENTS_LIST");
            void model.load({
              version: 1,
              type: "ASSIGNMENTS_LIST",
              courseSelector: course.courseSelector,
            });
          }}
          onRecording={(handle) => void model.openRecording(handle)}
          recordingPending={recordingAction.pending}
          usedRecordingHandles={recordingAction.used}
        />
      )}
    </section>
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
