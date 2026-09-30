import type { ReactNode } from "react";
export function ScreenHeader({
  title,
  subtitle,
  action,
}: {
  readonly title: string;
  readonly subtitle?: string;
  readonly action?: ReactNode;
}) {
  return (
    <header className="screen-header">
      <div className="toolbar">
        <h1>{title}</h1>
        {action}
      </div>
      {subtitle && <p className="hint">{subtitle}</p>}
    </header>
  );
}
