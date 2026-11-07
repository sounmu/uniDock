import { Icon } from "./icons";
export type Section = "courses" | "tasks" | "playback" | "captions";
const entries = [
  ["courses", "내 과목"],
  ["tasks", "할 일·일정"],
  ["playback", "자동 재생"],
  ["captions", "자막 추출"],
] as const;
export const PENDING_FEATURE_NOTICE = "현재 검토 중인 기능입니다.";
export function Rail({
  section,
  onSelect,
  onInfo,
  playbackAvailable,
  info = false,
  active = [],
}: {
  readonly section: Section;
  readonly onSelect: (section: Section) => void;
  readonly onInfo: () => void;
  readonly playbackAvailable: boolean;
  readonly info?: boolean;
  /** Sections with work in progress; marked with a dot. */
  readonly active?: readonly Section[];
}) {
  return (
    <header className="rail">
      <nav aria-label="주 메뉴">
        {entries.map(([value, label]) =>
          value === "playback" && !playbackAvailable ? (
            // Stays focusable (aria-disabled, not disabled) so keyboard users
            // can reach the notice; the tooltip is a sibling so it does not
            // become part of the button's accessible name.
            <div key={value} className="rail-pending">
              <button
                className="btn-ghost"
                aria-disabled="true"
                aria-describedby="rail-pending-playback"
                onClick={(event) => event.preventDefault()}
              >
                <Icon name={value} />
                <span>{label}</span>
              </button>
              <span
                id="rail-pending-playback"
                role="tooltip"
                className="rail-tooltip"
              >
                {PENDING_FEATURE_NOTICE}
              </span>
            </div>
          ) : (
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
          ),
        )}
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
