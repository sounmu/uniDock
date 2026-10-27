import { useEffect, useMemo, useState } from "react";
import {
  filterDeadlines,
  scheduleKind,
  scheduleKindLabels,
  scheduleTypeLabel,
  sortByDateDesc,
  sortByDue,
  type DeadlinePeriod,
  type ScheduleKind,
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
import { rowKey } from "./ui/a11y";
import { ItemDetail, isAssignment } from "./ItemDetail";
type Item = Deadline | Upcoming | Todo;
type SortOrder = "original" | "due" | "due-desc";
export { dateLabel } from "./ItemDetail";
const shortFormatter = new Intl.DateTimeFormat("ko-KR", {
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "Asia/Seoul",
});
const timeFormatter = new Intl.DateTimeFormat("ko-KR", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "Asia/Seoul",
});
const dayFormatter = new Intl.DateTimeFormat("ko-KR", {
  dateStyle: "short",
  timeZone: "Asia/Seoul",
});
function scheduleChip(item: Upcoming, now: number): string {
  const time = isoTime(item.date);
  if (!Number.isFinite(time)) return item.submitted ? "제출됨" : "예정";
  const when = shortFormatter.format(time);
  if (item.submitted) return `제출됨 ${when}`;
  if (time <= now) return `지남 ${when}`;
  return dayFormatter.format(time) === dayFormatter.format(now)
    ? `오늘 ${timeFormatter.format(time)}`
    : `예정 ${when}`;
}
function chip(item: Item, now: number): string {
  if ("date" in item) return scheduleChip(item, now);
  if (isAssignment(item)) {
    if (item.locked_for_user) return "잠김";
    if (["submitted", "graded"].includes(item.submission_workflow_state))
      return "제출됨";
    const delta = isoTime(item.due_at) - now;
    if (delta <= 0) return "마감 지남";
    return delta <= 86400000
      ? `${Math.max(1, Math.ceil(delta / 3600000))}시간 남음`
      : "남은 과제";
  }
  if ("type" in item && ["submitted", "graded"].includes(item.type))
    return "제출 완료";
  const delta = isoTime(item.due_at) - now;
  return delta <= 0 ? "마감 지남" : delta <= 86400000 ? "D-1" : "미제출";
}
function isOverdueTodo(item: Todo, now: number): boolean {
  return (
    !["submitted", "graded"].includes(item.type) && isoTime(item.due_at) <= now
  );
}
function ItemChip({
  item,
  now,
}: {
  readonly item: Item;
  readonly now: number;
}) {
  const label = chip(item, now);
  const done = label.startsWith("제출");
  const urgent =
    !done &&
    label !== "잠김" &&
    "due_at" in item &&
    isoTime(item.due_at) > now &&
    isoTime(item.due_at) - now <= 86400000;
  return (
    <StatusChip urgent={urgent} done={done}>
      {label}
    </StatusChip>
  );
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
  const [sort, setSort] = useState<SortOrder>(todo ? "due-desc" : "due");
  // Schedule rows mix announcements with graded work; "all" keeps LMS order.
  const [kind, setKind] = useState<ScheduleKind | "all">("all");
  const [now, setNow] = useState(Date.now);
  const { detail, open, back } = useDetail<Item>();
  useEffect(() => {
    const update = () => setNow(Date.now());
    const timer = window.setInterval(update, 1000);
    window.addEventListener("focus", update);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", update);
    };
  }, []);
  const ordered = useMemo(() => {
    if (deadlines) {
      const rows = items.filter(
        (item): item is Deadline => "remaining_candidate" in item,
      );
      return sort === "original" ? rows : sortByDue(rows);
    }
    if (todo) {
      const rows = items.filter((item): item is Todo => "ignore" in item);
      return sort === "original" ? rows : sortByDue(rows, sort === "due-desc");
    }
    // Schedule rows show the most recent date first; undated rows go last.
    return sortByDateDesc(
      items.filter(
        (item): item is Upcoming =>
          "date" in item &&
          (kind === "all" || scheduleKind(item.type) === kind),
      ),
    );
  }, [items, deadlines, todo, sort, kind]);
  const visible = useMemo(
    () =>
      deadlines
        ? filterDeadlines(
            ordered.filter(
              (item): item is Deadline => "remaining_candidate" in item,
            ),
            { remainingOnly, period, sort: false },
            now,
          )
        : ordered,
    [ordered, deadlines, remainingOnly, period, now],
  );
  const schedule = !deadlines && !todo;
  const kindCounts = useMemo(() => {
    const counts: Record<ScheduleKind, number> = {
      task: 0,
      notice: 0,
      other: 0,
    };
    if (schedule)
      for (const item of items)
        if ("date" in item) counts[scheduleKind(item.type)]++;
    return counts;
  }, [items, schedule]);
  // Unsubmitted Todo rows past their due time collapse into a trailing group.
  const [current, overdue] = useMemo(() => {
    if (!todo) return [visible, []];
    const rows = visible as Todo[];
    return [
      rows.filter((item) => !isOverdueTodo(item, now)),
      rows.filter((item) => isOverdueTodo(item, now)),
    ];
  }, [visible, todo, now]);
  const resetKey = useMemo(
    () => ({}),
    [items, remainingOnly, period, sort, kind],
  );
  const row = (item: Item) => (
    <li key={rowKey(item)}>
      <ListRow
        title={item.title}
        course={
          "date" in item
            ? [item.course, scheduleTypeLabel(item.type)]
                .filter(Boolean)
                .join(" · ")
            : "course" in item
              ? item.course
              : course
        }
        chip={<ItemChip item={item} now={now} />}
        onClick={() => open(item)}
      />
    </li>
  );
  return (
    <>
      <div hidden={detail !== null}>
        {(deadlines || todo) && (
          <details className="view-settings">
            <summary data-analytics-action="view_options">보기 설정</summary>
            <div className="view-settings-body">
              {deadlines && (
                <label className="remaining-toggle">
                  <input
                    type="checkbox"
                    checked={remainingOnly}
                    data-analytics-action="filter_remaining"
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
                      data-analytics-action="filter_period"
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
                    value={sort}
                    data-analytics-action="sort"
                    onChange={(e) => {
                      const value = e.target.value;
                      if (
                        value === "original" ||
                        value === "due" ||
                        value === "due-desc"
                      )
                        setSort(value);
                    }}
                  >
                    <option value="original">LMS 순서</option>
                    <option value="due">마감 빠른 순</option>
                    {todo && <option value="due-desc">마감 늦은 순</option>}
                  </select>
                </label>
              </div>
              {deadlines && (
                <p className="hint">
                  이번 주는 한국 시간 월요일부터 일요일까지입니다. 제출 상태는
                  마지막 조회 시점 기준입니다. 새로고침하면 갱신됩니다.
                </p>
              )}
            </div>
          </details>
        )}
        {schedule && items.length > 0 && (
          <nav className="subviews kind-filter" aria-label="일정 종류">
            {(
              [
                ["all", "전체", items.length],
                ["task", scheduleKindLabels.task, kindCounts.task],
                ["notice", scheduleKindLabels.notice, kindCounts.notice],
                ["other", scheduleKindLabels.other, kindCounts.other],
              ] as const
            )
              // "기타" appears only when used, but stays while selected so a
              // later result without such rows never hides the active filter.
              .filter(
                ([value, , count]) =>
                  value !== "other" || count > 0 || kind === "other",
              )
              .map(([value, label, count]) => (
                <button
                  key={value}
                  className="btn-ghost"
                  aria-pressed={kind === value}
                  data-analytics-action="filter_kind"
                  onClick={() => setKind(value)}
                >
                  {label}
                  <span className="kind-count">{count}</span>
                </button>
              ))}
          </nav>
        )}
        <p className="count">
          조회 완료 · {items.length}개 항목
          {(deadlines || (schedule && kind !== "all")) &&
            ` 중 ${visible.length}개 표시`}{" "}
          · 한국 시간
        </p>
        {current.length === 0 ? (
          <div className="notice">
            {items.length === 0
              ? "조회된 항목이 없습니다."
              : schedule
                ? "선택한 종류의 일정이 없습니다."
                : overdue.length > 0
                  ? "마감 전인 할 일이 없습니다."
                  : "조건에 맞는 과제가 없습니다."}
          </div>
        ) : (
          <PagedList items={current} resetKey={resetKey}>
            {row}
          </PagedList>
        )}
        {overdue.length > 0 && (
          <details className="overdue-group">
            <summary data-analytics-action="toggle_overdue">
              마감 지남
              <span className="overdue-count">{overdue.length}개</span>
            </summary>
            <p className="hint">
              제출하지 않은 채 마감이 지난 항목입니다. 지각 제출 가능 여부는
              LMS에서 확인하세요.
            </p>
            <PagedList items={overdue} resetKey={resetKey}>
              {row}
            </PagedList>
          </details>
        )}
      </div>
      {detail && (
        <ItemDetail item={detail} course={course} now={now} onBack={back} />
      )}
    </>
  );
}
