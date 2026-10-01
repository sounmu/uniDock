import type { ReactNode } from "react";
import { remainingLabel } from "../../src/deadline-view";
import {
  isoTime,
  type Assignment,
  type Deadline,
  type Todo,
  type Upcoming,
} from "../../src/domain-items";
import { DetailView } from "./ui/DetailView";
export function isAssignment(
  item: Deadline | Todo | Upcoming,
): item is Assignment {
  return "submission_workflow_state" in item;
}
const dateFormatter = new Intl.DateTimeFormat("ko-KR", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Asia/Seoul",
});
export function dateLabel(value: string): string {
  if (!value) return "일정 없음";
  const time = isoTime(value);
  return Number.isFinite(time) ? dateFormatter.format(time) : "날짜 확인 필요";
}
export function ItemDetail({
  item,
  course,
  now,
  onBack,
}: {
  readonly item: Deadline | Todo | Upcoming;
  readonly course: string;
  readonly now: number;
  readonly onBack: () => void;
}) {
  const meta: (readonly [string, ReactNode])[] = [
    [
      "과목",
      "course" in item ? item.course || "정보 없음" : course || "정보 없음",
    ],
    [
      "date" in item ? "일시" : "마감",
      dateLabel("date" in item ? item.date : item.due_at),
    ],
  ];
  if ("due_at" in item)
    meta.push(["남은 시간", remainingLabel(item.due_at, now)]);
  if ("type" in item) meta.push(["유형", item.type || "정보 없음"]);
  if ("submitted" in item)
    meta.push(
      ["제출 기록", item.submitted ? "제출 기록 있음" : "제출 기록 없음"],
      ["새 활동", item.new_activity ? "새 활동" : "없음"],
    );
  if (isAssignment(item))
    meta.push(
      ["제출 상태", item.submission_workflow_state || "정보 없음"],
      ["점수", item.points_possible ?? "정보 없음"],
      ["제출 유형", item.submission_types.join(", ") || "정보 없음"],
      ["제출 시각", dateLabel(item.submitted_at)],
      [
        "공개·잠금",
        [
          item.locked_for_user ? "잠김" : "잠금 해제",
          item.missing ? "누락" : "",
          item.late ? "지각 제출" : "",
          !item.published ? "미공개" : "공개",
        ]
          .filter(Boolean)
          .join(" · "),
      ],
    );
  return (
    <DetailView title={item.title || "제목 없음"} onBack={onBack} meta={meta}>
      {isAssignment(item) ? (
        <p className="hint">
          실제 제출 가능 여부는 LMS에서 확인하세요. 남은 후보는 조회된 제출
          상태를 기준으로 하며 상태 갱신은 새로고침이 필요합니다.
        </p>
      ) : (
        "html_url" in item &&
        item.html_url && (
          <a
            className="btn-primary item-title-link"
            data-analytics-action="lms_open"
            href={item.html_url}
            target="_blank"
            rel="noreferrer"
          >
            LMS에서 열기 ↗
          </a>
        )
      )}
    </DetailView>
  );
}
