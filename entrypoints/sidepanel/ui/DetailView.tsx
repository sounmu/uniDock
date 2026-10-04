import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { restoreFocus } from "./a11y";
export function useDetail<T>() {
  const [detail, setDetail] = useState<T | null>(null);
  const saved = useRef<{ top: number; element: Element | null } | null>(null);
  useLayoutEffect(() => {
    if (detail !== null) {
      if (window.scrollY) window.scrollTo(0, 0);
    } else if (saved.current) {
      if (saved.current.top) window.scrollTo(0, saved.current.top);
      restoreFocus(saved.current.element);
      saved.current = null;
    }
  }, [detail]);
  return {
    detail,
    open: (value: T) => {
      saved.current = { top: window.scrollY, element: document.activeElement };
      setDetail(value);
    },
    back: () => setDetail(null),
  };
}
export function DetailView({
  title,
  meta = [],
  onBack,
  children,
}: {
  readonly title: string;
  readonly meta?: readonly (readonly [string, ReactNode])[];
  readonly onBack: () => void;
  readonly children?: ReactNode;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, []);
  return (
    <section className="detail-view">
      <button
        className="btn-ghost"
        onClick={onBack}
        data-analytics-action="back"
      >
        ← 목록
      </button>
      <h2 ref={heading} tabIndex={-1}>
        {title}
      </h2>
      <dl>
        {meta.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {children}
    </section>
  );
}
