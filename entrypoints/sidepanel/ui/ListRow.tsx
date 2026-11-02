import type { ReactNode } from "react";
export function ListRow({
  title,
  course,
  chip,
  onClick,
  disabled = false,
}: {
  readonly title: string;
  readonly course: string;
  readonly chip?: ReactNode;
  readonly onClick: () => void;
  readonly disabled?: boolean;
}) {
  return (
    <button className="list-row" onClick={onClick} disabled={disabled}>
      <strong>{title || "제목 없음"}</strong>
      <span className="row-meta">
        <span className="row-course">{course}</span>
        {chip}
      </span>
    </button>
  );
}
