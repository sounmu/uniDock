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
}: {
  readonly section: Section;
  readonly onSelect: (section: Section) => void;
  readonly onInfo: () => void;
  readonly playbackAvailable: boolean;
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
              aria-current={section === value ? "page" : undefined}
              onClick={() => onSelect(value)}
            >
              <Icon name={value} />
              <span>{label}</span>
            </button>
          ),
        )}
      </nav>
      <div className="rail-footer">
        <a
          href="https://mylms.korea.ac.kr/"
          target="_blank"
          rel="noreferrer"
          aria-label="LMS 열기 ↗"
        >
          <Icon name="external" />
          <span>LMS 열기</span>
        </a>
        <button className="btn-ghost" onClick={onInfo}>
          정보
        </button>
        <a href="privacy.html" target="_blank" rel="noreferrer">
          개인정보
        </a>
      </div>
    </header>
  );
}
