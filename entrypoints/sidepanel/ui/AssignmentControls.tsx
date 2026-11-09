import { useId } from "react";
import type { Deadline } from "../../../src/domain-items";
import { filterDeadlines, type DeadlinePeriod } from "../../../src/deadline-view";
import type { AssignmentFreshnessState } from "./AssignmentRefresh";
import { ViewControls } from "./ViewControls";
import { Select } from "./Select";

export type AssignmentFilters = {
  readonly remainingOnly: boolean;
  readonly period: DeadlinePeriod;
  readonly sort: "original" | "due" | "due-desc";
};
const periods: readonly { value: DeadlinePeriod; label: string }[] = [
  { value: "all", label: "전체 기간" },
  { value: "today", label: "오늘" },
  { value: "week", label: "이번 주" },
  { value: "day", label: "24시간 이내" },
  { value: "next7", label: "7일 이내" },
];
const orders: readonly { value: AssignmentFilters["sort"]; label: string }[] = [
  { value: "due", label: "마감 빠른 순" },
  { value: "due-desc", label: "마감 늦은 순" },
  { value: "original", label: "LMS 순서" },
];
export const defaultAssignmentFilters: AssignmentFilters = {
  remainingOnly: true, period: "all", sort: "due",
};

export function AssignmentControls({
  items, filters, now, onApply, freshness,
}: {
  readonly items: readonly Deadline[];
  readonly filters: AssignmentFilters;
  readonly now: number;
  readonly onApply: (filters: AssignmentFilters) => void;
  readonly freshness?: AssignmentFreshnessState;
}) {
  const id = useId();
  const count = (value: AssignmentFilters) =>
    filterDeadlines(items, { ...value, sort: false }, now).length;
  const changed = filters.period !== "all" || filters.sort !== "due";
  const summary = changed
    ? [
        ...(filters.period !== "all"
          ? [periods.find((option) => option.value === filters.period)?.label]
          : []),
        orders.find((option) => option.value === filters.sort)?.label,
      ].join(" · ")
    : undefined;
  return (
    <ViewControls
      heading={`${filters.remainingOnly ? "남은 과제" : "과제"} ${count(filters).toLocaleString()}개`}
      dialogLabel="과제 보기 변경"
      question="어떤 과제를 볼까요?"
      noun="과제"
      filters={filters}
      defaults={defaultAssignmentFilters}
      preview={count}
      hint="한국 시간"
      fields={(draft, setDraft) => (
        <>
          <div className="subviews assignment-scope" role="group" aria-label="과제 범위">
            <button className="btn-ghost" aria-pressed={draft.remainingOnly}
              onClick={() => setDraft({ ...draft, remainingOnly: true })}>남은 과제</button>
            <button className="btn-ghost" aria-pressed={!draft.remainingOnly}
              onClick={() => setDraft({ ...draft, remainingOnly: false })}>전체</button>
          </div>
          <div className="assignment-view-fields">
            <div className="field">
              <label htmlFor={`${id}-period`}>마감 기간</label>
              <Select id={`${id}-period`} value={draft.period} onChange={(event) => {
                const selected = periods.find((option) => option.value === event.target.value);
                if (selected) setDraft({ ...draft, period: selected.value });
              }}>
                {periods.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </Select>
            </div>
            <div className="field">
              <label htmlFor={`${id}-sort`}>정렬</label>
              <Select id={`${id}-sort`} value={draft.sort} onChange={(event) => {
                const selected = orders.find((option) => option.value === event.target.value);
                if (selected) setDraft({ ...draft, sort: selected.value });
              }}>
                {orders.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </Select>
            </div>
          </div>
        </>
      )}
      help={
        <details className="assignment-criteria">
          <summary>남은 과제 기준</summary>
          <p>아직 제출하지 않았고, 잠금이 풀려 있으며 마감 전인 과제예요. 실제 제출 가능 여부는 LMS에서 확인하세요. 제출 상태는 새로고침할 때 갱신돼요.</p>
          <p>이번 주는 한국 시간 월요일부터 일요일까지예요.</p>
        </details>
      }
      onApply={onApply}
      freshness={freshness}
      summary={summary}
    />
  );
}
