import { useEffect, useMemo, useState } from "react";
import {
  filterDeadlines,
  sortByDue,
  type DeadlinePeriod,
} from "../../src/deadline-view";
import { PagedList } from "./PagedList";
import {
  isoTime,
  type Deadline,
  type Upcoming,
  type Todo,
} from "../../src/domain-items";
import { ListRow } from "./ui/ListRow";
import { StatusChip } from "./ui/StatusChip";
import { useDetail } from "./ui/DetailView";
import { ItemDetail, isAssignment } from "./ItemDetail";
type Item = Deadline | Upcoming | Todo;
export { dateLabel } from "./ItemDetail";
const shortFormatter = new Intl.DateTimeFormat("ko-KR", {
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "Asia/Seoul",
});
function chip(item: Item, now: number): string {
  if ("date" in item)
    return `예정${Number.isFinite(isoTime(item.date)) ? ` ${shortFormatter.format(isoTime(item.date))}` : ""}`;
  if (isAssignment(item)) {
    if (item.locked_for_user) return "잠김";
    if (["submitted", "graded"].includes(item.submission_workflow_state))
      return "제출됨";
    return isoTime(item.due_at) <= now ? "마감 지남" : "남은 과제";
  }
  if ("type" in item && ["submitted", "graded"].includes(item.type))
    return "제출 완료";
  const delta = isoTime(item.due_at) - now;
  return delta <= 0 ? "마감 지남" : delta <= 86400000 ? "D-1" : "미제출";
}
export function ItemResults({
  items,
  deadlines,
  todo = false,
  course = "",
}: {
  readonly items: Item[];
  readonly deadlines: boolean;
  readonly todo?: boolean;
  readonly course?: string;
}) {
  const [remainingOnly, setRemainingOnly] = useState(true);
  const [period, setPeriod] = useState<DeadlinePeriod>("all");
  const [sort, setSort] = useState(false);
  const [now, setNow] = useState(Date.now);
  const { detail, open, back } = useDetail<Item>();
  useEffect(() => {
    if (!deadlines && !todo) return;
    const update = () => setNow(Date.now());
    const timer = window.setInterval(update, 1000);
    window.addEventListener("focus", update);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", update);
    };
  }, [deadlines, todo]);
  const visible = useMemo(() => {
    if (deadlines)
      return filterDeadlines(
        items.filter((item): item is Deadline => "remaining_candidate" in item),
        { remainingOnly, period, sort },
        now,
      );
    return todo && sort
      ? sortByDue(items.filter((item): item is Todo => "ignore" in item))
      : items;
  }, [items, deadlines, todo, remainingOnly, period, sort, now]);
  const resetKey = useMemo(() => ({}), [items, remainingOnly, period, sort]);
  return (
    <>
      <div hidden={detail !== null}>
        {(deadlines || todo) && (
          <details className="view-settings">
            <summary>보기 설정</summary>
            <div className="view-settings-body">
              {deadlines && (
                <label className="remaining-toggle">
                  <input
                    type="checkbox"
                    checked={remainingOnly}
                    onChange={(e) => setRemainingOnly(e.target.checked)}
                  />
                  남은 과제만
                </label>
              )}
              <div className="date-fields">
                {deadlines && (
                  <label className="field">
                    마감 기간
                    <select
                      value={period}
                      onChange={(e) => {
                        const value = e.target.value;
                        if (
                          value === "all" ||
                          value === "week" ||
                          value === "day"
                        )
                          setPeriod(value);
                      }}
                    >
                      <option value="all">전체 기간</option>
                      <option value="week">이번 주</option>
                      <option value="day">24시간 이내</option>
                    </select>
                  </label>
                )}
                <label className="field">
                  정렬
                  <select
                    value={sort ? "due" : "original"}
                    onChange={(e) => setSort(e.target.value === "due")}
                  >
                    <option value="original">LMS 순서</option>
                    <option value="due">마감 빠른 순</option>
                  </select>
                </label>
              </div>
              {deadlines && (
                <p className="hint">
                  이번 주는 한국 시간 월–일 기준입니다. 남은 후보는 조회된 제출
                  상태를 기준으로 하며, 상태 갱신은 새로고침이 필요합니다.
                </p>
              )}
            </div>
          </details>
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
          <PagedList items={visible} resetKey={resetKey}>
            {(item, index) => (
              <li key={index}>
                <ListRow
                  title={item.title}
                  course={"course" in item ? item.course : course}
                  chip={
                    <StatusChip
                      urgent={
                        "due_at" in item &&
                        isoTime(item.due_at) > now &&
                        isoTime(item.due_at) - now <= 86400000
                      }
                    >
                      {chip(item, now)}
                    </StatusChip>
                  }
                  onClick={() => open(item)}
                />
              </li>
            )}
          </PagedList>
        )}
      </div>
      {detail && (
        <ItemDetail item={detail} course={course} now={now} onBack={back} />
      )}
    </>
  );
}
