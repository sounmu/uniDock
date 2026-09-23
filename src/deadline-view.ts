import { isoTime, type Deadline } from "./domain-items";

export type DeadlinePeriod = "all" | "week" | "day";
const day = 86400000;
const koreaOffset = 9 * 3600000;

export function sortByDue<T extends Pick<Deadline, "due_at">>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const first = isoTime(a.due_at),
      second = isoTime(b.due_at);
    if (!Number.isFinite(first)) return Number.isFinite(second) ? 1 : 0;
    if (!Number.isFinite(second)) return -1;
    return first - second;
  });
}

export function filterDeadlines<T extends Deadline>(
  items: T[],
  options: { remainingOnly: boolean; period: DeadlinePeriod; sort: boolean },
  now: number,
): T[] {
  const korea = new Date(now + koreaOffset);
  const monday =
    Date.UTC(korea.getUTCFullYear(), korea.getUTCMonth(), korea.getUTCDate()) -
    koreaOffset -
    ((korea.getUTCDay() + 6) % 7) * day;
  const filtered = items.filter((item) => {
    const due = isoTime(item.due_at);
    if (options.remainingOnly && !(item.remaining_candidate && due > now))
      return false;
    if (options.period === "day") return due > now && due <= now + day;
    if (options.period === "week")
      return due >= monday && due < monday + 7 * day;
    return true;
  });
  return options.sort ? sortByDue(filtered) : filtered;
}

export function remainingLabel(due: string, now: number): string {
  if (!due) return "마감일 없음";
  const delta = isoTime(due) - now;
  if (!Number.isFinite(delta)) return "마감일 확인 필요";
  if (delta <= 0) return "마감 지남";
  if (delta < 60000) return "1분 미만 남음";
  const minutes = Math.floor(delta / 60000);
  if (minutes < 60) return `${minutes}분 남음`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24)
    return `${hours}시간${minutes % 60 ? ` ${minutes % 60}분` : ""} 남음`;
  return `${Math.floor(hours / 24)}일${hours % 24 ? ` ${hours % 24}시간` : ""} 남음`;
}
