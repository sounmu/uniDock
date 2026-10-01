import { useRef, useState } from "react";
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
export function App() {
  const gate = useRef(new QueryGate()).current;
  const model = useSidepanelQuery(gate);
  const [info, setInfo] = useState(false);
  const analytics = useAnalytics(info ? "INFO" : model.view);
  const infoTrigger = useRef<Element | null>(null);
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
      <Rail section={model.section} onSelect={select} onInfo={showInfo} />
      <main>
        {!info && analytics.available && analytics.choice === "undecided" && (
          <aside className="notice">
            <p>사용 통계 공유는 선택 사항입니다. 현재는 수집하지 않습니다.</p>
            <button className="btn-secondary" onClick={showInfo}>
              통계 공유 설정 보기
            </button>
          </aside>
        )}
        <div hidden={info}>
          {model.section === "courses" && <CoursesScreen model={model} />}
          {model.section === "tasks" && <TasksScreen model={model} />}
          {model.section === "playback" && <PlaybackPanel gate={gate} />}
          {model.section === "captions" && <CaptionsPanel />}
        </div>
        {info && (
          <DetailView
            title="정보"
            onBack={() => {
              setInfo(false);
              // The rail stays mounted, so its trigger can take focus back.
              if (infoTrigger.current instanceof HTMLElement)
                infoTrigger.current.focus({ preventScroll: true });
            }}
          >
            <p>조회 시 현재 LMS 세션의 정보를 이 기기에 표시합니다.</p>
            <p>
              LMS 정보는 분석 서비스로 전송하지 않습니다. 재생 설정과 선택한
              통계 공유 설정은 이 기기에 저장합니다.
            </p>
            <a
              href="privacy.html"
              target="_blank"
              rel="noreferrer"
              data-analytics-action="privacy_open"
            >
              개인정보 처리방침
            </a>
            <p>고려대학교와 제휴하지 않은 비공식 도구입니다.</p>
            <AnalyticsSettings status={analytics} />
          </DetailView>
        )}
      </main>
    </>
  );
}
