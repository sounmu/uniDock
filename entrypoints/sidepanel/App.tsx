import { useRef, useState } from "react";
import { PlaybackPanel } from "./PlaybackPanel";
import { CaptionsPanel } from "./CaptionsPanel";
import { useSidepanelQuery } from "./useSidepanelQuery";
import { Rail, type Section } from "./ui/Rail";
import { DetailView } from "./ui/DetailView";
import { CoursesScreen } from "./screens/CoursesScreen";
import { TasksScreen } from "./screens/TasksScreen";
import { QueryGate } from "./query-gate";
export function App() {
  const gate = useRef(new QueryGate()).current;
  const model = useSidepanelQuery(gate);
  const [info, setInfo] = useState(false);
  const infoTrigger = useRef<Element | null>(null);
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
        onInfo={() => {
          model.downloads.cancel();
          infoTrigger.current = document.activeElement;
          setInfo(true);
        }}
      />
      <main>
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
              setInfo(false);
              // The rail stays mounted, so its trigger can take focus back.
              if (infoTrigger.current instanceof HTMLElement)
                infoTrigger.current.focus({ preventScroll: true });
            }}
          >
            <p>조회 시 현재 LMS 세션의 정보를 이 기기에 표시합니다.</p>
            <p>
              {__UNIDOCK_PLAYBACK__
                ? "개발자 서버로 전송하지 않으며, 자막·PDF 다운로드 외에는 재생 설정만 이 기기에 저장합니다."
                : "개발자 서버로 전송하지 않습니다. 조회 결과는 메모리에만 잠시 유지하고, 다운로드한 자막·PDF는 기기에 저장됩니다."}
            </p>
            <a href="privacy.html" target="_blank" rel="noreferrer">
              개인정보 처리방침
            </a>
            <p>고려대학교와 제휴하지 않은 비공식 도구입니다.</p>
          </DetailView>
        )}
      </main>
    </>
  );
}
