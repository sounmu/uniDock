import { CaptionsPanel } from "./CaptionsPanel";
import { ResultList } from "./ResultList";
import { messages, tabs, useSidepanelQuery } from "./useSidepanelQuery";

export function App() {
  const {
    view,
    setView,
    course,
    setCourse,
    start,
    setStart,
    end,
    setEnd,
    state,
    recordingAction,
    clear,
    showCourses,
    load,
    openRecording,
    needsCourse,
    query,
    isQueryValid,
  } = useSidepanelQuery();
  return (
    <main>
      <nav className="views" aria-label="주 메뉴">
        <button
          aria-pressed={view === "COURSES_LIST" || needsCourse}
          onClick={showCourses}
        >
          내 과목
        </button>
        <button
          aria-pressed={view === "UPCOMING_LIST"}
          onClick={() => {
            setCourse("");
            setView("UPCOMING_LIST");
            void load({
              version: 1,
              type: "UPCOMING_LIST",
              ...(start ? { start_date: start } : {}),
              ...(end ? { end_date: end } : {}),
            });
          }}
        >
          전체 일정
        </button>
        <button
          aria-pressed={view === "TODO_LIST"}
          onClick={() => {
            setCourse("");
            setView("TODO_LIST");
            void load({ version: 1, type: "TODO_LIST" });
          }}
        >
          Todo
        </button>
        <button
          aria-pressed={view === "CAPTIONS"}
          onClick={() => {
            clear();
            setCourse("");
            setView("CAPTIONS");
          }}
        >
          자막 추출
        </button>
      </nav>
      {needsCourse && (
        <section className="course-context">
          <button className="back-link" onClick={showCourses}>
            ← 과목 선택
          </button>
          <h2>{course}</h2>
          <nav className="subviews" aria-label="과목 메뉴">
            {(
              [
                ["ASSIGNMENTS_LIST", "과제"],
                ["DEADLINES_LIST", "마감일"],
                ["RECORDINGS_LIST", "녹화 강의"],
              ] as const
            ).map(([type, label]) => (
              <button
                key={type}
                aria-pressed={view === type}
                onClick={() => {
                  setView(type);
                  void load({ version: 1, type, course });
                }}
              >
                {label}
              </button>
            ))}
          </nav>
        </section>
      )}
      {view === "UPCOMING_LIST" && (
        <div className="date-fields">
          <label className="field">
            시작일 (선택)
            <input
              type="date"
              value={start}
              onChange={(event) => {
                clear();
                setStart(event.target.value);
              }}
            />
          </label>
          <label className="field">
            종료일 (선택)
            <input
              type="date"
              value={end}
              onChange={(event) => {
                clear();
                setEnd(event.target.value);
              }}
            />
          </label>
        </div>
      )}
      {view === "UPCOMING_LIST" && start && end && start > end && (
        <p className="filter-error">종료일은 시작일 이후여야 합니다.</p>
      )}
      {view === "CAPTIONS" ? (
        <CaptionsPanel />
      ) : (
        <>
          <div className="toolbar">
            <h3>{tabs.find(([type]) => type === view)?.[1]}</h3>
            <button
              onClick={() => void load(query)}
              disabled={state.status === "loading" || !isQueryValid}
            >
              {state.status === "loading"
                ? "조회 중…"
                : state.status === "success"
                  ? "새로고침"
                  : "조회"}
            </button>
          </div>
          {view === "RECORDINGS_LIST" && (
            <p className="hint">
              외부 도구 항목 중 녹화 강의 후보를 표시합니다. LTI 탭은 LMS를 거쳐
              열립니다. 재생은 열린 LMS에서 직접 조작하세요. LMS 자체 재생으로
              시청·출석 기록이 반영될 수 있습니다.
            </p>
          )}
          {view === "DEADLINES_LIST" && (
            <p className="hint">
              기본값은 남은 과제 후보만 표시합니다. ‘남은 후보’는 미제출·잠금
              해제·미래 마감 기준이며 실제 제출 가능 여부는{" "}
              <span className="nowrap">LMS에서</span> 확인하세요.
            </p>
          )}
          <section
            aria-live="polite"
            aria-busy={state.status === "loading" || recordingAction.pending}
          >
            {view === "RECORDINGS_LIST" && recordingAction.notice && (
              <p className="notice">{recordingAction.notice}</p>
            )}
            {state.status === "idle" && (
              <div className="notice">
                <strong>
                  {view === "COURSES_LIST"
                    ? "내 과목부터 시작하세요."
                    : "일정을 확인하세요."}
                </strong>
                <p>
                  {view === "COURSES_LIST"
                    ? "LMS 탭을 선택하고 조회를 누르세요. 과목을 선택하면 과제·마감일·녹화 강의를 확인할 수 있습니다."
                    : view === "TODO_LIST"
                      ? "조회 버튼을 눌러 할 일을 불러오세요."
                      : "조회 버튼을 눌러 선택한 기간의 일정을 불러오세요."}
                </p>
              </div>
            )}
            {state.status === "loading" && (
              <div className="notice">목록을 불러오고 있습니다…</div>
            )}
            {state.status === "error" && (
              <div className="notice error">
                <strong>
                  {state.code === "LOGIN_REQUIRED"
                    ? "로그인 필요"
                    : "조회 안내"}
                </strong>
                <p>{messages[state.code]}</p>
              </div>
            )}
            {state.status === "success" && (
              <ResultList
                result={state}
                onRecordings={(name) => {
                  setCourse(name);
                  setView("RECORDINGS_LIST");
                  void load({
                    version: 1,
                    type: "RECORDINGS_LIST",
                    course: name,
                  });
                }}
                onRecording={(handle) => void openRecording(handle)}
                recordingPending={recordingAction.pending}
                usedRecordingHandles={recordingAction.used}
                onCourse={(name) => {
                  setCourse(name);
                  setView("ASSIGNMENTS_LIST");
                  void load({
                    version: 1,
                    type: "ASSIGNMENTS_LIST",
                    course: name,
                  });
                }}
              />
            )}
          </section>
        </>
      )}
      <a
        className="lms-link"
        href="https://mylms.korea.ac.kr/"
        target="_blank"
        rel="noreferrer"
      >
        LMS 열기 ↗
      </a>
      <footer>
        조회 시 현재 LMS 세션의 정보를 이 기기에 표시합니다.
        <br />
        개발자 서버로 전송하지 않으며, 직접 다운로드한 자막 추출 외에는 저장하지
        않습니다.{" "}
        <a href="privacy.html" target="_blank" rel="noreferrer">
          개인정보 처리방침
        </a>
        <p>고려대학교와 제휴하지 않은 비공식 도구입니다.</p>
      </footer>
    </main>
  );
}
