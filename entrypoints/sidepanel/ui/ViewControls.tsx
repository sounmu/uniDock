import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { AssignmentFreshness, type AssignmentFreshnessState } from "./AssignmentRefresh";

// Draft values apply only on the primary action; Escape, an outside pointer
// and focus leaving the popover discard them.
export function ViewControls<T>({
  heading,
  dialogLabel,
  question,
  noun,
  filters,
  defaults,
  preview,
  hint,
  fields,
  help,
  onApply,
  freshness,
  summary,
}: {
  readonly heading: string;
  readonly dialogLabel: string;
  readonly question: string;
  readonly noun: string;
  readonly filters: T;
  readonly defaults: T;
  readonly preview: (draft: T) => number;
  readonly hint?: string;
  readonly fields: (draft: T, setDraft: (next: T) => void) => ReactNode;
  readonly help: ReactNode;
  readonly onApply: (filters: T) => void;
  readonly freshness?: AssignmentFreshnessState;
  readonly summary?: string;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(filters);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const count = preview(draft);
  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLElement>("button, select, input")?.focus();
    const outside = (event: Event) => {
      if (event.target instanceof Node && !root.current?.contains(event.target))
        setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  return (
    <>
      <div className="assignment-view-anchor" ref={root}>
        <div className="assignment-toolbar">
          <h1>{heading}</h1>
          <button ref={trigger} className="btn-secondary assignment-view-toggle"
            aria-label="보기 변경" aria-haspopup="dialog" aria-expanded={open} aria-controls={id}
            onClick={() => { setDraft(filters); setOpen(!open); }}>
            보기 변경 <span aria-hidden="true">▾</span>
          </button>
        </div>
        {open && (
          <div id={id} ref={panel} className="assignment-view-panel" role="dialog" aria-label={dialogLabel}>
            <h2>{question}</h2>
            {fields(draft, setDraft)}
            <p className="hint" role="status">
              {count ? `${count.toLocaleString()}개 ${noun}가 있어요` : `이 조건에 맞는 ${noun}가 없어요`}
              {hint && ` · ${hint}`}
            </p>
            {help}
            <div className="assignment-view-actions">
              <button className="btn-secondary" onClick={() => setDraft(defaults)}>초기화</button>
              <button className="btn-primary" onClick={() => {
                onApply(draft); setOpen(false); trigger.current?.focus();
              }}>{count ? `${count.toLocaleString()}개 ${noun} 보기` : "결과 확인하기"}</button>
            </div>
          </div>
        )}
      </div>
      {freshness && <AssignmentFreshness {...freshness} />}
      {summary && <p className="assignment-view-summary">{summary}</p>}
    </>
  );
}
