import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { PlaybackPanel } from "./PlaybackPanel";
import type { PlaybackEntry } from "./usePlaybackPanel";
import { CaptionsPanel } from "./CaptionsPanel";
import { useSidepanelQuery } from "./useSidepanelQuery";
import { Rail, type Section, type ToolSection } from "./ui/Rail";
import { useDetail } from "./ui/DetailView";
import { CoursesScreen } from "./screens/CoursesScreen";
import { TasksScreen } from "./screens/TasksScreen";
import { HomeScreen } from "./screens/HomeScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { ProgressStrip } from "./ProgressStrip";
import { useActivity } from "./progress-activity";
import { QueryGate } from "./query-gate";
import { useAnalytics } from "./useAnalytics";
import { markNoticeShown, setAnalyticsEnabled } from "./analytics";
import type { AnalyticsNotice } from "../../src/analytics/contract";
import { UpdateNotice } from "./UpdateNotice";
import { restoreFocus } from "./ui/a11y";

function manifestVersion(): string {
  try { return chrome.runtime.getManifest().version; } catch { return ""; }
}
export function App() {
  const gate = useRef(new QueryGate()).current;
  const model = useSidepanelQuery(gate);
  const tool = useDetail<ToolSection>();
  const navigationRevision = useRef(0);
  const [info, setInfo] = useState(false);
  const [captionsOpened, setCaptionsOpened] = useState(false);
  const [captionEntry, setCaptionEntry] = useState<{ readonly title: string }>();
  const [playbackOpened, setPlaybackOpened] = useState(false);
  const [playbackEntry, setPlaybackEntry] = useState<PlaybackEntry>();
  const analytics = useAnalytics(info ? "INFO" : tool.detail === "captions" ? "CAPTIONS"
    : tool.detail === "playback" ? "PLAYBACK" : model.view === "HOME" ? null : model.view);
  const [notice, setNotice] = useState<AnalyticsNotice | null>(null);
  const noticeOpen = notice ?? (analytics.available && analytics.enabled ? analytics.notice : null);
  useEffect(() => {
    if (notice || !analytics.available || !analytics.enabled || !analytics.notice) return;
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
  const toolHeading = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    if (tool.detail) toolHeading.current?.focus({ preventScroll: true });
  }, [tool.detail]);
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
    navigationRevision.current++;
    if (!info) {
      infoTrigger.current = document.activeElement;
      infoScroll.current = window.scrollY;
    }
    setInfoTarget(target);
    setInfo(true);
  }
  function openTool(section: ToolSection) {
    if (section === "playback" && !__UNIDOCK_PLAYBACK__) return;
    navigationRevision.current++;
    setInfo(false);
    if (section === "playback") setPlaybackOpened(true);
    else setCaptionsOpened(true);
    tool.open(section);
  }
  function select(section: Section) {
    navigationRevision.current++;
    setInfo(false);
    tool.dismiss();
    switch (section) {
      case "home":
        model.setView("HOME");
        void model.load({ version: 1, type: "TODO_LIST" });
        break;
      case "courses":
        model.showCourses();
        break;
      case "tasks":
        model.setView(model.tasksMode === "todo" ? "TODO_LIST" : "UPCOMING_LIST");
        void model.load(model.tasksMode === "todo" ? { version: 1, type: "TODO_LIST" } : {
          version: 1, type: "UPCOMING_LIST",
          ...(model.start ? { start_date: model.start } : {}),
          ...(model.end ? { end_date: model.end } : {}),
        });
        break;
      default: {
        const exhaustive: never = section;
        return exhaustive;
      }
    }
  }
  return (
    <>
      <Rail section={model.section} onSelect={select} onInfo={() => showInfo()}
        info={info} active={activity.length ? ["home"] : []} />
      <main>
        <ProgressStrip activity={activity.filter((entry) => info || entry.section !== tool.detail)} onOpen={openTool} />
        <UpdateNotice />
        {noticeOpen && !noticeDismissed && (
          <aside hidden={info} className="notice" aria-label="사용 통계 안내">
            <p>{noticeOpen === "changed"
              ? "사용 통계 방식이 바뀌었습니다. 개별 이벤트와 설치 식별자 대신 기능별 하루 합계만 보내며 기본으로 켜집니다."
              : "기능 개선을 위해 기능별 사용 횟수와 성공·실패를 하루 합계로 보냅니다(기본 켜짐)."}{" "}
              개인정보는 보내지 않습니다. 설정 → 사용 통계에서 언제든 끌 수 있습니다.</p>
            <div className="tools">
              <button className="btn-secondary" onClick={() => setNoticeDismissed(true)}>확인</button>
              <button className="btn-ghost" onClick={() => { setNoticeDismissed(true); void setAnalyticsEnabled(false); }}>통계 끄기</button>
              <button className="btn-ghost" onClick={() => showInfo("analytics-title")}>자세히</button>
            </div>
          </aside>
        )}
        <div hidden={info || tool.detail !== null}>
          {model.section === "home" && <HomeScreen model={model} onTool={openTool} onSchedule={() => {
            navigationRevision.current++;
            model.setView("TODO_LIST");
            void model.load({ version: 1, type: "TODO_LIST" });
          }} />}
          {model.section === "courses" && <CoursesScreen model={model}
            onPlayback={__UNIDOCK_PLAYBACK__ ? (handle) => {
              const entry = model.takePlaybackEntry(handle);
              if (!entry) return;
              setPlaybackEntry(entry);
              openTool("playback");
            } : undefined}
            onCaptions={async (handle) => {
              const revision = navigationRevision.current;
              const title = model.state.status === "success" && "recordings" in model.state
                ? model.state.recordings.find((row) => row.launchHandle === handle)?.title : undefined;
              if (
                title !== undefined && await model.openRecording(handle) &&
                revision === navigationRevision.current
              ) {
                setCaptionEntry({ title });
                openTool("captions");
              }
            }} />}
          {model.section === "tasks" && <TasksScreen model={model} />}
        </div>
        <div hidden={info || tool.detail === null}>
          <p ref={toolHeading} tabIndex={-1} className="tool-return">
            <button className="btn-ghost" onClick={tool.back}>← 돌아가기</button>
          </p>
          {__UNIDOCK_PLAYBACK__ && playbackOpened && (
            <div hidden={tool.detail !== "playback"}><PlaybackPanel gate={gate} entry={playbackEntry} /></div>
          )}
          {captionsOpened && (
            <div hidden={tool.detail !== "captions"}>
              <CaptionsPanel entry={captionEntry} onConnectionSettings={() => showInfo("caption-server-title")} />
            </div>
          )}
        </div>
        {info && <SettingsScreen analytics={analytics} version={version} onBack={() => {
          restoreInfoFocus.current = true;
          setInfo(false);
        }} />}
      </main>
    </>
  );
}
