import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { PlaybackPanel } from "./PlaybackPanel";
import { CaptionsPanel } from "./CaptionsPanel";
import { useSidepanelQuery } from "./useSidepanelQuery";
import { Rail, type Section } from "./ui/Rail";
import { DetailView } from "./ui/DetailView";
import { CoursesScreen } from "./screens/CoursesScreen";
import { TasksScreen } from "./screens/TasksScreen";
import { ProgressStrip } from "./ProgressStrip";
import { useActivity } from "./progress-activity";
import { QueryGate } from "./query-gate";
import { useAnalytics } from "./useAnalytics";
import { AnalyticsSettings } from "./AnalyticsSettings";
import { markNoticeShown, setAnalyticsEnabled } from "./analytics";
import type { AnalyticsNotice } from "../../src/analytics/contract";
import { LocalDataSettings } from "./LocalDataSettings";
import { CaptionServerSettings } from "./CaptionServerSettings";
import { PopupSettings } from "./PopupSettings";
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
  const [captionsOpened, setCaptionsOpened] = useState(false);
  const analytics = useAnalytics(info ? "INFO" : model.view);
  // The notice stays until dismissed in this panel even after it is marked shown.
  const [notice, setNotice] = useState<AnalyticsNotice | null>(null);
  const noticeOpen =
    notice ??
    (analytics.available && analytics.enabled ? analytics.notice : null);
  useEffect(() => {
    if (notice || !analytics.available || !analytics.enabled || !analytics.notice)
      return;
    setNotice(analytics.notice);
    void markNoticeShown();
  }, [notice, analytics.available, analytics.enabled, analytics.notice]);
  const [noticeDismissed, setNoticeDismissed] = useState(false);
  const infoTrigger = useRef<Element | null>(null);
  const infoScroll = useRef(0);
  const [infoTarget, setInfoTarget] = useState<"analytics-title" | "caption-server-title" | null>(null);
  const [version] = useState(manifestVersion);
  const activity = useActivity(__UNIDOCK_AI_CAPTIONS__ || __UNIDOCK_PLAYBACK__);
  const restoreInfoFocus = useRef(false);
  // Runs after the list is unhidden, so a fallback heading can take focus.
  useLayoutEffect(() => {
    if (info) {
      if (infoTarget) document.getElementById(infoTarget)?.focus();
      else if (window.scrollY) window.scrollTo(0, 0);
      return;
    }
    if (!restoreInfoFocus.current) return;
    restoreInfoFocus.current = false;
    restoreFocus(infoTrigger.current);
    if (window.scrollY !== infoScroll.current) window.scrollTo(0, infoScroll.current);
  }, [info, infoTarget]);
  function showInfo(target: typeof infoTarget = null) {
    if (!info) {
      infoTrigger.current = document.activeElement;
      infoScroll.current = window.scrollY;
    }
    setInfoTarget(target);
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
        setCaptionsOpened(true);
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
        onInfo={() => showInfo()}
        info={info}
        active={activity.map((entry) => entry.section)}
      />
      <main>
        <ProgressStrip
          activity={activity.filter((entry) => info || entry.section !== model.section)}
          onOpen={(section) => {
            setInfo(false);
            select(section);
          }}
        />
        <UpdateNotice />
        {noticeOpen && !noticeDismissed && (
          <aside hidden={info} className="notice" aria-label="사용 통계 안내">
            <p>
              {noticeOpen === "changed"
                ? "사용 통계 방식이 바뀌었습니다. 개별 이벤트와 설치 식별자 대신 기능별 하루 합계만 보내며 기본으로 켜집니다."
                : "기능 개선을 위해 기능별 사용 횟수와 성공·실패를 하루 합계로 보냅니다(기본 켜짐)."}{" "}
              학번·이름·과목명·LMS 주소·자막·파일 내용은 보내지 않습니다. 설정 → 사용
              통계에서 언제든 끌 수 있습니다.
            </p>
            <div className="tools">
              <button
                className="btn-secondary"
                onClick={() => setNoticeDismissed(true)}
              >
                확인
              </button>
              <button
                className="btn-ghost"
                onClick={() => {
                  setNoticeDismissed(true);
                  void setAnalyticsEnabled(false);
                }}
              >
                통계 끄기
              </button>
              <button
                className="btn-ghost"
                onClick={() => showInfo("analytics-title")}
              >
                자세히
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
          {captionsOpened && (
            <div hidden={model.section !== "captions"}>
              <CaptionsPanel onConnectionSettings={() => showInfo("caption-server-title")} />
            </div>
          )}
        </div>
        {info && (
          <DetailView
            title="설정"
            backLabel="돌아가기"
            onBack={() => {
              restoreInfoFocus.current = true;
              setInfo(false);
            }}
          >
            <PopupSettings />
            {__UNIDOCK_AI_CAPTIONS__ && <CaptionServerSettings />}
            <section className="settings-group" aria-labelledby="privacy-title">
              <h3 id="privacy-title" className="settings-label">
                개인정보·데이터
              </h3>
              <div className="settings-card">
                <div className="settings-row">
                  <div className="row-text">
                    <p className="row-title">LMS 정보는 이 기기에서만 표시</p>
                    <p className="row-sub">
                      조회 시 현재 LMS 세션의 정보를 이 기기에 표시하며 분석
                      서비스로 전송하지 않습니다.{" "}
                      {__UNIDOCK_PLAYBACK__
                        ? "통계 공유·팝업 자동 닫기·재생 설정은 이 기기에 저장합니다."
                        : "조회 결과는 메모리에만 잠시 유지하고, 다운로드한 자막·자료, 통계 공유와 팝업 자동 닫기 설정은 기기에 저장됩니다."}
                    </p>
                  </div>
                </div>
                <a
                  className="settings-row settings-link"
                  href="privacy.html"
                  target="_blank"
                  rel="noreferrer"
                >
                  <span className="row-title">개인정보 처리방침</span>
                  <Icon name="external" />
                </a>
              </div>
              <AnalyticsSettings status={analytics} />
              <LocalDataSettings />
            </section>
            <section className="settings-group" aria-labelledby="about-title">
              <h3 id="about-title" className="settings-label">
                uniDock 정보
              </h3>
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
              <div className="settings-card">
                <a
                  className="settings-row settings-link"
                  href="https://mylms.korea.ac.kr/"
                  target="_blank"
                  rel="noreferrer"
                  aria-label="LMS 열기 (새 탭)"
                  data-analytics-action="lms_open"
                >
                  <span className="row-title">LMS 열기</span>
                  <Icon name="external" />
                </a>
                <a
                  className="settings-row settings-link"
                  href="updates.html"
                  target="_blank"
                  rel="noreferrer"
                >
                  <span className="row-title">현재 버전 변경 사항</span>
                  <Icon name="external" />
                </a>
                <a
                  className="settings-row settings-link"
                  href="privacy.html"
                  target="_blank"
                  rel="noreferrer"
                >
                  <span className="row-title">개인정보 처리방침</span>
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
