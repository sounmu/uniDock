import { useLayoutEffect, useRef, useState } from "react";
import { PlaybackPanel } from "./PlaybackPanel";
import { CaptionsPanel } from "./CaptionsPanel";
import { useSidepanelQuery } from "./useSidepanelQuery";
import { Rail, type Section } from "./ui/Rail";
import { DetailView } from "./ui/DetailView";
import { CoursesScreen } from "./screens/CoursesScreen";
import { TasksScreen } from "./screens/TasksScreen";
import { QueryGate } from "./query-gate";
import { useAnalytics } from "./useAnalytics";
import { AnalyticsSettings } from "./AnalyticsSettings";
import { LocalDataSettings } from "./LocalDataSettings";
import { UpdateNotice } from "./UpdateNotice";
import { Icon } from "./ui/icons";
import { restoreFocus } from "./ui/a11y";

function manifestVersion(): string {
  try {
    return chrome.runtime.getManifest().version;
  } catch {
    return "";
  }
}
export function App() {
  const gate = useRef(new QueryGate()).current;
  const model = useSidepanelQuery(gate);
  const [info, setInfo] = useState(false);
  // "나중에" hides the consent reminder for this panel only; nothing is stored.
  const [consentDeferred, setConsentDeferred] = useState(false);
  const analytics = useAnalytics(info ? "INFO" : model.view);
  const infoTrigger = useRef<Element | null>(null);
  const [version] = useState(manifestVersion);
  const restoreInfoFocus = useRef(false);
  // Runs after the list is unhidden, so a fallback heading can take focus.
  useLayoutEffect(() => {
    if (info || !restoreInfoFocus.current) return;
    restoreInfoFocus.current = false;
    restoreFocus(infoTrigger.current);
  }, [info]);
  function showInfo() {
    model.downloads.cancel();
    infoTrigger.current = document.activeElement;
    setInfo(true);
  }
  function select(section: Section) {
    setInfo(false);
    switch (section) {
      case "courses":
        model.showCourses();
        break;
      case "tasks": {
        model.setView(
          model.tasksMode === "todo" ? "TODO_LIST" : "UPCOMING_LIST",
        );
        void model.load(
          model.tasksMode === "todo"
            ? { version: 1, type: "TODO_LIST" }
            : {
                version: 1,
                type: "UPCOMING_LIST",
                ...(model.start ? { start_date: model.start } : {}),
                ...(model.end ? { end_date: model.end } : {}),
              },
        );
        break;
      }
      case "playback":
        if (!__UNIDOCK_PLAYBACK__) return;
        model.clear();
        model.setView("PLAYBACK");
        break;
      case "captions":
        model.clear();
        model.setView("CAPTIONS");
        break;
      default: {
        const exhaustive: never = section;
        return exhaustive;
      }
    }
  }
  return (
    <>
      <Rail
        section={model.section}
        onSelect={select}
        playbackAvailable={__UNIDOCK_PLAYBACK__}
        onInfo={showInfo}
      />
      <main>
        <UpdateNotice />
        {!info &&
          !consentDeferred &&
          analytics.available &&
          analytics.choice === "undecided" && (
            <aside className="notice" aria-label="사용 통계 공유 안내">
              <p>사용 통계 공유는 선택 사항입니다. 현재는 수집하지 않습니다.</p>
              <div className="tools">
                <button className="btn-secondary" onClick={showInfo}>
                  통계 공유 설정 보기
                </button>
                <button
                  className="btn-ghost"
                  onClick={() => setConsentDeferred(true)}
                >
                  나중에
                </button>
              </div>
            </aside>
          )}
        <div hidden={info}>
          {model.section === "courses" && <CoursesScreen model={model} />}
          {model.section === "tasks" && <TasksScreen model={model} />}
          {__UNIDOCK_PLAYBACK__ && model.section === "playback" && (
            <PlaybackPanel gate={gate} />
          )}
          {model.section === "captions" && <CaptionsPanel />}
        </div>
        {info && (
          <DetailView
            title="정보"
            onBack={() => {
              restoreInfoFocus.current = true;
              setInfo(false);
            }}
          >
            <div className="about-app">
              <img src="icons/48.png" alt="" width={40} height={40} />
              <div>
                <p className="about-name">uniDock</p>
                <p className="about-meta">
                  {version ? `버전 ${version} · ` : ""}고려대학교와 제휴하지
                  않은 비공식 도구
                </p>
              </div>
            </div>
            <section className="settings-group" aria-labelledby="privacy-title">
              <h3 id="privacy-title" className="settings-label">
                개인정보
              </h3>
              <div className="settings-card">
                <div className="settings-row">
                  <div className="row-text">
                    <p className="row-title">LMS 정보는 이 기기에서만 표시</p>
                    <p className="row-sub">
                      조회 시 현재 LMS 세션의 정보를 이 기기에 표시하며 분석
                      서비스로 전송하지 않습니다.{" "}
                      {__UNIDOCK_PLAYBACK__
                        ? "통계 공유·재생 설정은 이 기기에 저장합니다."
                        : "조회 결과는 메모리에만 잠시 유지하고, 다운로드한 자막·자료와 통계 공유 설정은 기기에 저장됩니다."}
                    </p>
                  </div>
                </div>
                <a
                  className="settings-row settings-link"
                  href="privacy.html"
                  target="_blank"
                  rel="noreferrer"
                  data-analytics-action="privacy_open"
                >
                  <span className="row-title">개인정보 처리방침</span>
                  <Icon name="external" />
                </a>
              </div>
            </section>
            <AnalyticsSettings status={analytics} />
            <LocalDataSettings />
            <section className="settings-group" aria-labelledby="about-title">
              <h3 id="about-title" className="settings-label">
                업데이트
              </h3>
              <div className="settings-card">
                <a
                  className="settings-row settings-link"
                  href="updates.html"
                  target="_blank"
                  rel="noreferrer"
                >
                  <span className="row-title">현재 버전 변경 사항</span>
                  <Icon name="external" />
                </a>
              </div>
            </section>
          </DetailView>
        )}
      </main>
    </>
  );
}
