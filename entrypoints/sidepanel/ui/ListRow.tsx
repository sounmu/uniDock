import type { ReactNode } from "react";
import type { AnalyticsAction } from "../../../src/analytics/contract";
export function ListRow({
  title,
  course,
  chip,
  onClick,
  disabled = false,
  analyticsAction = "item_detail",
}: {
  readonly title: string;
  readonly course: string;
  readonly chip?: ReactNode;
  readonly onClick: () => void;
  readonly disabled?: boolean;
  readonly analyticsAction?: AnalyticsAction;
}) {
  return (
    <button
      className="list-row"
      onClick={onClick}
      disabled={disabled}
      data-analytics-action={analyticsAction}
    >
      <strong>{title || "제목 없음"}</strong>
      <span className="row-meta">
        <span className="row-course">{course}</span>
        {chip}
      </span>
    </button>
  );
}
