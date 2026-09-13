import { useState, type ReactNode } from "react";
const pageSize = 100;
export function PagedList<T>({
  items,
  children,
  resetKey = items,
}: {
  items: readonly T[];
  resetKey?: unknown;
  children: (item: T, index: number) => ReactNode;
}) {
  const [selection, setSelection] = useState({ resetKey, page: 0 });
  // Reset for a new response, but keep the page when action status changes.
  if (selection.resetKey !== resetKey) setSelection({ resetKey, page: 0 });
  const page =
    selection.resetKey === resetKey
      ? Math.min(
          selection.page,
          Math.max(0, Math.ceil(items.length / pageSize) - 1),
        )
      : 0;
  const start = page * pageSize;
  const end = Math.min(start + pageSize, items.length);
  return (
    <>
      {items.length > pageSize && (
        <nav className="pagination" aria-label="목록 페이지">
          <button
            className="secondary"
            disabled={page === 0}
            onClick={() => setSelection({ resetKey, page: page - 1 })}
          >
            이전
          </button>
          <span aria-live="polite">
            {start + 1}–{end} / {items.length}개
          </span>
          <button
            className="secondary"
            disabled={end === items.length}
            onClick={() => setSelection({ resetKey, page: page + 1 })}
          >
            다음
          </button>
        </nav>
      )}
      <ul>
        {items
          .slice(start, end)
          .map((item, index) => children(item, start + index))}
      </ul>
    </>
  );
}
