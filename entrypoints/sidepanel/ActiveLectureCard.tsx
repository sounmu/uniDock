import type { ActiveLecture } from "./useActiveLecture";
import { Icon } from "./ui/icons";

export function ActiveLectureCard({
  lecture,
  onOpen,
}: {
  readonly lecture: ActiveLecture;
  readonly onOpen: () => void;
}) {
  return (
    <div className="progress-strip">
      <button type="button" className="progress-row" onClick={onOpen}>
        <Icon name="captions" />
        <span className="progress-row-text">
          <strong>지금 보는 강의 자막 추출</strong>
          <small>{lecture.title || "열려 있는 강의 영상"}</small>
        </span>
      </button>
    </div>
  );
}
