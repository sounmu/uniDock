import { Icon } from "./icons";
export type Section = "home" | "courses" | "tasks";
export type ToolSection = "playback" | "captions";
const entries = [
  ["home", "홈"],
  ["courses", "내 과목"],
  ["tasks", "일정"],
] as const;
export function Rail({
  section,
  onSelect,
  onInfo,
  info = false,
  active = [],
}: {
  readonly section: Section;
  readonly onSelect: (section: Section) => void;
  readonly onInfo: () => void;
  readonly info?: boolean;
  readonly active?: readonly Section[];
}) {
  return (
    <header className="rail">
      <nav className="subviews" aria-label="주 메뉴">
        {entries.map(([value, label]) => (
          <button
            key={value}
            className="btn-ghost"
            aria-current={!info && section === value ? "page" : undefined}
            onClick={() => onSelect(value)}
          >
            <span className="rail-icon">
              <Icon name={value} />
              {active.includes(value) && <span className="rail-dot" aria-hidden="true" />}
            </span>
            <span>{label}</span>
          </button>
        ))}
        <button
          className="btn-ghost"
          aria-current={info ? "page" : undefined}
          onClick={onInfo}
        >
          <Icon name="settings" />
          <span>설정</span>
        </button>
      </nav>
    </header>
  );
}
