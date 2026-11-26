import { progressText } from "../../src/progress";
import type { Activity } from "./progress-activity";
import { Icon } from "./ui/icons";
import type { ToolSection } from "./ui/Rail";

export function ProgressStrip({
  activity,
  onOpen,
}: {
  readonly activity: readonly Activity[];
  readonly onOpen: (section: ToolSection) => void;
}) {
  const rows = activity.flatMap(({ section, item }) => {
    const text = progressText(item);
    return text ? [{ section, text }] : [];
  });
  if (!rows.length) return null;
  return (
    <div className="progress-strip">
      {rows.map(({ section, text }) => (
        <button
          key={section}
          type="button"
          className="progress-row"
          data-tone={text.tone}
          onClick={() => onOpen(section)}
        >
          <Icon name={section} />
          <span className="progress-row-text">
            <strong>{text.title}</strong>
            <small>{text.detail}</small>
          </span>
          {text.percent !== null && (
            <svg className="progress-row-ring" viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="9.5" />
              <circle
                cx="12"
                cy="12"
                r="9.5"
                pathLength={100}
                strokeDasharray={`${text.percent} 100`}
                transform="rotate(-90 12 12)"
              />
            </svg>
          )}
        </button>
      ))}
    </div>
  );
}
