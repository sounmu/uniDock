import { progressText } from "../../src/progress";
import type { Activity } from "./progress-activity";
import { Icon } from "./ui/icons";
import type { Section } from "./ui/Rail";

export function ProgressStrip({
  activity,
  onOpen,
}: {
  readonly activity: readonly Activity[];
  readonly onOpen: (section: Section) => void;
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
            <span className="progress-row-bar" aria-hidden="true">
              <i style={{ width: `${text.percent}%` }} />
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
