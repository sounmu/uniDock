import { useEffect, useState } from "react";
import { isoTime, type Todo } from "../../../src/domain-items";
import { ItemDetail, dateLabel } from "../ItemDetail";
import { messages } from "../query-messages";
import { ScreenHeader } from "../ui/ScreenHeader";
import { ListRow } from "../ui/ListRow";
import { Notice } from "../ui/Notice";
import { useDetail } from "../ui/DetailView";
import { Icon } from "../ui/icons";
import { rowKey } from "../ui/a11y";
import type { ToolSection } from "../ui/Rail";
import { Refresh, Skeleton, type PanelModel } from "./QueryResults";

export function HomeScreen({
  model,
  onTool,
  onSchedule,
}: {
  readonly model: PanelModel;
  readonly onTool: (tool: ToolSection) => void;
  readonly onSchedule: () => void;
}) {
  const { detail, open, back } = useDetail<Todo>();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const { state } = model;
  const todo = state.status === "success" && "todo" in state ? state.todo : null;
  const upcoming = todo?.filter((item) => isoTime(item.due_at) > now)
    .sort((a, b) => isoTime(a.due_at) - isoTime(b.due_at)).slice(0, 3);
  return (
    <>
      <div hidden={detail !== null} className="home-screen">
        <ScreenHeader title="홈" action={<Refresh model={model} />} />
        <section aria-labelledby="home-deadlines" aria-busy={state.status === "loading"}>
          <div className="toolbar">
            <h2 id="home-deadlines">다가오는 마감</h2>
            <button className="btn-ghost" onClick={onSchedule}>전체 할 일</button>
          </div>
          {state.status === "idle" && <Notice>LMS 탭을 선택하고 새로고침하면 남은 과제를 확인할 수 있습니다.</Notice>}
          {state.status === "loading" && <Skeleton />}
          {state.status === "error" && <Notice error>{messages[state.code]}</Notice>}
          {upcoming && (upcoming.length ? (
            <ul>
              {upcoming.map((item) => (
                <li key={rowKey(item)}>
                  <ListRow title={item.title} course={item.course}
                    chip={<time className="home-due" dateTime={item.due_at}>{dateLabel(item.due_at)}</time>}
                    onClick={() => open(item)} />
                </li>
              ))}
            </ul>
          ) : <Notice>다가오는 마감이 없습니다. 마감이 지났거나 날짜가 없는 과제는 전체 할 일에서 확인하세요.</Notice>)}
        </section>
        <section aria-labelledby="home-tools">
          <h2 id="home-tools">강의 도구</h2>
          <div className="settings-card">
            {__UNIDOCK_PLAYBACK__ && (
              <button className="settings-row settings-link home-tool" aria-label="자동 재생" aria-describedby="home-playback-description" onClick={() => onTool("playback")}>
                <Icon name="playback" />
                <span className="row-text"><span className="row-title">자동 재생</span><span className="row-sub" id="home-playback-description">과목의 영상을 골라 순서대로 재생</span></span>
              </button>
            )}
            <button className="settings-row settings-link home-tool" aria-label="자막 추출" aria-describedby="home-captions-description" onClick={() => onTool("captions")}>
              <Icon name="captions" />
              <span className="row-text"><span className="row-title">자막 추출</span><span className="row-sub" id="home-captions-description">현재 열린 강의의 자막 확인</span></span>
            </button>
          </div>
        </section>
      </div>
      {detail && <ItemDetail item={detail} course={detail.course} now={now} onBack={back} />}
    </>
  );
}
