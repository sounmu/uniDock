import { ResultList } from "../ResultList";
import type { useSidepanelQuery } from "../useSidepanelQuery";
import { messages } from "../query-messages";
import { Notice } from "../ui/Notice";
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
      {state.status === "loading" && <Notice>목록을 불러오고 있습니다…</Notice>}
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
            void model.load({ version: 1, type: "ASSIGNMENTS_LIST", course });
          }}
          onRecording={(handle) => void model.openRecording(handle)}
          recordingPending={recordingAction.pending}
          usedRecordingHandles={recordingAction.used}
        />
      )}
    </section>
  );
}
export function Refresh({ model }: { readonly model: PanelModel }) {
  return (
    <button
      className="btn-primary"
      disabled={model.state.status === "loading" || !model.isQueryValid}
      onClick={() => void model.load(model.query)}
    >
      {model.state.status === "loading" ? "조회 중…" : "새로고침"}
    </button>
  );
}
