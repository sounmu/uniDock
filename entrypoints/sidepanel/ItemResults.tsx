import { useEffect, useMemo, useState } from "react";
import {
  filterDeadlines,
  remainingLabel,
  type DeadlinePeriod,
} from "../../src/deadline-view";
import { PagedList } from "./PagedList";
import {
  isoTime,
  type Assignment,
  type Deadline,
  type Upcoming,
  type Todo,
} from "../../src/domain-items";

function isAssignment(item: Deadline | Upcoming | Todo): item is Assignment {
  return "submission_workflow_state" in item;
}

const dateFormatter = new Intl.DateTimeFormat("ko-KR", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Asia/Seoul",
});

export function dateLabel(value: string): string {
  if (!value) return "일정 없음";
  const time = isoTime(value);
  if (!Number.isFinite(time)) return "날짜 확인 필요";
  return dateFormatter.format(time);
}

export function ItemResults({
  items,
  deadlines,
}: {
  items: (Deadline | Upcoming | Todo)[];
  deadlines: boolean;
}) {
  const [remainingOnly, setRemainingOnly] = useState(true);
  const [period, setPeriod] = useState<DeadlinePeriod>("all");
  const [sort, setSort] = useState(false);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!deadlines) return;
    const update = () => setNow(Date.now());
    const timer = window.setInterval(update, 1000);
    window.addEventListener("focus", update);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", update);
    };
  }, [deadlines]);
  const visible = useMemo(
    () =>
      deadlines
        ? filterDeadlines(
            items as Deadline[],
            { remainingOnly, period, sort },
            now,
          )
        : items,
    [items, deadlines, remainingOnly, period, sort, now],
  );
  const resetKey = useMemo(() => ({}), [items, remainingOnly, period, sort]);
  return (
    <>
      {deadlines && (
        <div className="deadline-controls">
          <label className="remaining-toggle">
            <input
              type="checkbox"
              checked={remainingOnly}
              onChange={(event) => setRemainingOnly(event.target.checked)}
            />
            남은 과제 후보만
          </label>
          <div className="date-fields">
            <label className="field">
              마감 기간
              <select
                value={period}
                onChange={(event) =>
                  setPeriod(event.target.value as DeadlinePeriod)
                }
              >
                <option value="all">전체 기간</option>
                <option value="week">이번 주</option>
                <option value="day">24시간 이내</option>
              </select>
            </label>
            <label className="field">
              정렬
              <select
                value={sort ? "due" : "original"}
                onChange={(event) => setSort(event.target.value === "due")}
              >
                <option value="original">LMS 순서</option>
                <option value="due">마감 빠른 순</option>
              </select>
            </label>
          </div>
          <p className="hint">
            이번 주는 한국 시간 월–일 기준입니다. 남은 후보는 조회된 제출 상태를
            기준으로 하며, 상태 갱신은{" "}
            <span className="nowrap">새로고침이 필요합니다.</span>
          </p>
        </div>
      )}
      <p className="count">
        조회 완료 · {items.length}개 항목
        {deadlines && ` 중 ${visible.length}개 표시`} · 한국 시간
      </p>
      {visible.length === 0 ? (
        <div className="notice">
          {items.length === 0
            ? "조회된 항목이 없습니다."
            : "조건에 맞는 과제가 없습니다."}
        </div>
      ) : (
        <PagedList<Deadline | Upcoming | Todo>
          items={visible}
          resetKey={resetKey}
        >
          {(item, index) => (
            <li key={index}>
              <div className="item-body">
                <strong>
                  {"html_url" in item && item.html_url ? (
                    <a
                      className="item-title-link"
                      href={item.html_url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {item.title || "제목 없음"}
                    </a>
                  ) : (
                    item.title || "제목 없음"
                  )}
                </strong>
                {"course" in item && item.course && <p>{item.course}</p>}
                <p>
                  {"date" in item ? "예정" : "마감"} ·{" "}
                  {dateLabel("date" in item ? item.date : item.due_at)}
                </p>
                {deadlines && "due_at" in item && (
                  <p
                    className={`remaining-time${isoTime(item.due_at) > now && isoTime(item.due_at) - now <= 86400000 ? " urgent" : ""}`}
                  >
                    {remainingLabel(item.due_at, now)}
                  </p>
                )}
                {isAssignment(item) && (
                  <p>
                    제출 상태: {item.submission_workflow_state || "정보 없음"}
                    {item.locked_for_user ? " · 잠김" : ""}
                    {item.missing ? " · 누락" : ""}
                    {item.late ? " · 지각 제출" : ""}
                    {!item.published ? " · 미공개" : ""}
                  </p>
                )}
                {"remaining_candidate" in item && (
                  <span className="item-badge">
                    {item.remaining_candidate && isoTime(item.due_at) > now
                      ? "남은 과제 후보"
                      : "남은 과제 후보 아님"}
                  </span>
                )}
                {"submitted" in item && (
                  <span className="item-badge">
                    {item.submitted ? "제출 기록 있음" : "제출 기록 없음"}
                    {item.new_activity ? " · 새 활동" : ""}
                  </span>
                )}
                {"ignore" in item && (
                  <span className="item-badge">
                    {["submitted", "graded"].includes(item.type)
                      ? "제출 완료"
                      : item.type === "unsubmitted"
                        ? "미제출 과제"
                        : `과제${item.type ? ` · ${item.type}` : ""}`}
                  </span>
                )}
              </div>
            </li>
          )}
        </PagedList>
      )}
    </>
  );
}
