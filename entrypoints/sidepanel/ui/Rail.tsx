import { Icon } from "./icons";
export type Section = "courses" | "tasks" | "playback" | "captions";
const entries = [
  ["courses", "내 과목"],
  ["tasks", "할 일·일정"],
  ["playback", "자동 재생"],
  ["captions", "자막 추출"],
] as const;
export function Rail({
  section,
  onSelect,
  onInfo,
}: {
  readonly section: Section;
  readonly onSelect: (section: Section) => void;
  readonly onInfo: () => void;
}) {
  return (
    <header className="rail">
      <nav aria-label="주 메뉴">
        {entries.map(([value, label]) => (
          <button
            key={value}
            className="btn-ghost"
            aria-current={section === value ? "page" : undefined}
            onClick={() => onSelect(value)}
          >
            <Icon name={value} />
            <span>{label}</span>
          </button>
        ))}
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
