import type { ReactNode } from "react";
import { Icon } from "./icons";
export type RowStatus = "open" | "done" | "overdue" | "locked";
export function ListRow({
  title,
  course,
  chip,
  onClick,
  disabled = false,
  status,
}: {
  readonly title: string;
  readonly course: string;
  readonly chip?: ReactNode;
  readonly onClick: () => void;
  readonly disabled?: boolean;
  readonly status?: RowStatus;
}) {
  return (
    <button
      className={status ? "list-row has-status" : "list-row"}
      onClick={onClick}
      disabled={disabled}
    >
      {status && (
        <span className="row-status" data-status={status}>
          <Icon name={`status-${status}`} />
        </span>
      )}
      <strong>{title || "제목 없음"}</strong>
      <span className="row-meta">
        <span className="row-course">{course}</span>
        {chip}
      </span>
    </button>
  );
}
