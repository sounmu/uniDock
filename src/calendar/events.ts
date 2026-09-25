import {
  isoTime,
  projectAssignments,
  projectUpcoming,
  rows,
} from "../domain-items";
import { itemUrl } from "../security/item-link";
import { redactText } from "../security/redaction";

export type CalendarStatus =
  | "confirmed"
  | "ambiguous"
  | "changed"
  | "cancelled"
  | "duplicate"
  | "conflict"
  | "date-only";
export interface CalendarEvent {
  id: string;
  course: string;
  title: string;
  action?: string;
  target?: string;
  date?: string;
  time?: string;
  kind: "announcement" | "planner" | "assignment";
  status: CalendarStatus[];
  evidence: string;
  sourceUrl?: string;
  sourceRevision: string;
}
const statuses: CalendarStatus[] = [
  "confirmed",
  "ambiguous",
  "changed",
  "cancelled",
  "duplicate",
  "conflict",
  "date-only",
];
const plain = (value: string) =>
  redactText(value).replace(/\s+/g, " ").trim().slice(0, 500);
function identity(value: string): string {
  let hash = 2166136261;
  for (const char of value)
    hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(16).padStart(8, "0");
}
function safeText(value: unknown): string {
  if (typeof value !== "string" || value.length > 20000)
    throw new Error("INVALID_RESPONSE");
  return value;
}
function dateParts(
  year: string,
  month: string,
  day: string,
): string | undefined {
  const date = `${year.padStart(4, "0")}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  return Number.isFinite(isoTime(date)) ? date : undefined;
}
function htmlText(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc
    .querySelectorAll("script,style,template,svg,iframe,object,form")
    .forEach((node) => node.remove());
  doc
    .querySelectorAll("br,p,div,li,tr,h1,h2,h3,h4")
    .forEach((node) => node.prepend(doc.createTextNode("\n")));
  return doc.body.textContent ?? "";
}
function timeOf(line: string): string | undefined {
  const clock =
    /(?:^|\s)(오전|오후)?\s*(\d{1,2})(?::(\d{2})|시(?:\s*(\d{1,2})분?)?)/.exec(
      line,
    );
  if (!clock) return undefined;
  let hour = Number(clock[2]);
  const minute = Number(clock[3] ?? clock[4] ?? 0);
  if (hour > (clock[1] ? 12 : 23) || minute > 59) return undefined;
  if (clock[1]) hour = (hour % 12) + (clock[1] === "오후" ? 12 : 0);
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}
const dated =
  /(?<!\d)(\d{4})[-./년]\s*(\d{1,2})[-./월]\s*(\d{1,2})(?:일)?(?!\d)/g;
const yearless = /(?<!\d)(\d{1,2})(?:월|[/.])\s*(\d{1,2})(?:일)?(?!\d)/g;
const actionPattern =
  /(제출|마감|시험|중간고사|기말고사|평가|발표|수업|강의|시청|행사|휴강|취소|연기|변경|등록|신청|exam|submit|deadline|lecture|cancel)/i;
function describe(fragment: string) {
  const action = actionPattern
    .exec(fragment)?.[0]
    .replace(/(?:중간|기말)고사/, "시험");
  const target = plain(
    fragment
      .replace(dated, "")
      .replace(yearless, "")
      .replace(/(?:오전|오후)?\s*\d{1,2}(?::\d{2}|시(?:\s*\d{1,2}분?)?)/g, "")
      .replace(actionPattern, ""),
  );
  return {
    ...(action ? { action } : {}),
    ...(target ? { target } : {}),
  };
}
function nextWeekFriday(postedAt: string): string {
  const koreaDay = new Date(isoTime(postedAt) + 9 * 3_600_000);
  const weekday = koreaDay.getUTCDay();
  const daysUntilMonday = (8 - weekday) % 7 || 7;
  koreaDay.setUTCDate(koreaDay.getUTCDate() + daysUntilMonday + 4);
  return koreaDay.toISOString().slice(0, 10);
}
function seoulParts(timestamp: number) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(timestamp);
  const value = (part: string) =>
    parts.find(({ type }) => type === part)?.value ?? "";
  return {
    date: `${value("year")}-${value("month")}-${value("day")}`,
    time: `${value("hour")}:${value("minute")}`,
  };
}
export function announcementEvents(
  raw: unknown,
  courses: Map<string, string>,
  origin: string,
): CalendarEvent[] {
  if (!Array.isArray(raw) || raw.length > 1000)
    throw new Error("INVALID_RESPONSE");
  const output: CalendarEvent[] = [];
  for (const value of raw) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("INVALID_RESPONSE");
    const row = value as Record<string, unknown>;
    const id = String(row.id);
    if (
      !/^[1-9]\d{0,19}$/.test(id) ||
      typeof row.context_code !== "string" ||
      !/^course_[1-9]\d{0,19}$/.test(row.context_code) ||
      typeof row.posted_at !== "string" ||
      !Number.isFinite(isoTime(row.posted_at))
    )
      throw new Error("INVALID_RESPONSE");
    const course = courses.get(row.context_code.slice(7));
    if (!course) continue;
    const title = plain(htmlText(safeText(row.title)));
    const body = htmlText(safeText(row.message));
    const suppliedUrl = itemUrl(row.html_url, origin);
    const sourceUrl =
      suppliedUrl && !new URL(suppliedUrl).search && !new URL(suppliedUrl).hash
        ? suppliedUrl
        : itemUrl(
            `/courses/${row.context_code.slice(7)}/discussion_topics/${id}`,
            origin,
          );
    const lines = body
      .split(/[\n。!?;]+/)
      .map(plain)
      .filter(Boolean)
      .slice(0, 200);
    for (const [index, line] of lines.entries()) {
      const matches = [...line.matchAll(dated)].slice(0, 20);
      const reschedule =
        matches.length === 2 &&
        /(?:에서|부터|→|->|from)\s*.*(?:으로|로|까지|to)/i.test(line);
      for (const [position, match] of matches.entries()) {
        if (reschedule && position === 0) continue;
        const date = dateParts(match[1]!, match[2]!, match[3]!);
        const previous = matches[position - 1];
        const before = line.slice(
          previous ? previous.index! + previous[0].length : 0,
          match.index,
        );
        const preceding =
          position === 0 ? before : before.slice(before.lastIndexOf(",") + 1);
        const trailing = line.slice(
          match.index!,
          matches[position + 1]?.index ?? line.length,
        );
        const suffix =
          !reschedule && matches[position + 1] && trailing.includes(",")
            ? trailing.slice(0, trailing.lastIndexOf(","))
            : trailing;
        const fragment = `${preceding} ${suffix}`.trim();
        const time = timeOf(fragment);
        const ambiguous =
          !date ||
          reschedule ||
          /(?:미정|추후|tentative|tbd|혹은|또는)/i.test(fragment);
        const status: CalendarStatus[] = [
          ambiguous ? "ambiguous" : "confirmed",
        ];
        if (
          /(?:변경|연기|수정|정정|changed|revis|reschedul|postpon)/i.test(line)
        )
          status.push("changed");
        if (/(?:취소|휴강|cancel)/i.test(line)) status.push("cancelled");
        if (date && !time) status.push("date-only");
        output.push({
          id: `announcement:${identity(`${origin}:${row.context_code}:${id}:${index}:${reschedule ? "change" : position}`)}`,
          course,
          title: plain(fragment) || title,
          ...describe(fragment),
          ...(date ? { date } : {}),
          ...(time && date ? { time } : {}),
          kind: "announcement",
          status,
          evidence: plain(reschedule ? line : fragment),
          ...(sourceUrl ? { sourceUrl } : {}),
          sourceRevision:
            typeof row.updated_at === "string" &&
            Number.isFinite(isoTime(row.updated_at))
              ? row.updated_at
              : row.posted_at,
        });
      }
      // Yearless dates are retained as unresolved evidence, never assigned a year.
      if (!matches.length && [...line.matchAll(yearless)].length) {
        for (const [position, match] of [
          ...line.matchAll(yearless),
        ].entries()) {
          const fragment = line
            .slice(
              match.index!,
              [...line.matchAll(yearless)][position + 1]?.index ?? line.length,
            )
            .trim();
          output.push({
            id: `announcement:${identity(`${origin}:${row.context_code}:${id}:${index}:unresolved:${position}`)}`,
            course,
            title: plain(fragment) || title,
            ...describe(fragment),
            kind: "announcement",
            status: ["ambiguous"],
            evidence: plain(fragment),
            ...(sourceUrl ? { sourceUrl } : {}),
            sourceRevision: row.posted_at,
          });
        }
      } else if (!matches.length && /다음\s*주\s*금요일/.test(line)) {
        output.push({
          id: `announcement:${identity(`${origin}:${row.context_code}:${id}:${index}:relative`)}`,
          course,
          title: plain(line),
          ...describe(line),
          date: nextWeekFriday(row.posted_at),
          kind: "announcement",
          status: ["ambiguous", "date-only"],
          evidence: line,
          ...(sourceUrl ? { sourceUrl } : {}),
          sourceRevision: row.posted_at,
        });
      } else if (!matches.length && /다음\s*수업/.test(line)) {
        output.push({
          id: `announcement:${identity(`${origin}:${row.context_code}:${id}:${index}:undated`)}`,
          course,
          title: plain(line),
          ...describe(line),
          kind: "announcement",
          status: ["ambiguous"],
          evidence: line,
          ...(sourceUrl ? { sourceUrl } : {}),
          sourceRevision: row.posted_at,
        });
      } else if (
        !matches.length &&
        /(?:취소|휴강|연기|변경|cancel)/i.test(line) &&
        actionPattern.test(line)
      ) {
        output.push({
          id: `announcement:${identity(`${origin}:${row.context_code}:${id}:${index}:change`)}`,
          course,
          title: plain(line),
          ...describe(line),
          kind: "announcement",
          status: [
            "ambiguous",
            /(?:취소|휴강|cancel)/i.test(line) ? "cancelled" : "changed",
          ],
          evidence: line,
          ...(sourceUrl ? { sourceUrl } : {}),
          sourceRevision: row.posted_at,
        });
      }
      if (output.length > 10000) throw new Error("LIMIT");
    }
  }
  return output;
}
export function plannerEvents(raw: unknown, origin: string): CalendarEvent[] {
  return projectUpcoming(raw, origin).flatMap((item, index) => {
    const timestamp = isoTime(item.date);
    if (!Number.isFinite(timestamp)) return [];
    const zoned = item.date.length > 10 ? seoulParts(timestamp) : undefined;
    const date = zoned?.date ?? item.date.slice(0, 10);
    if (!Number.isFinite(isoTime(date))) return [];
    const time = zoned?.time;
    return [
      {
        id: `planner:${identity(`${index}:${date}:${item.title}:${item.course}`)}`,
        course: item.course,
        title: item.title,
        date,
        ...(time ? { time } : {}),
        kind: "planner" as const,
        status: time
          ? ["confirmed" as const]
          : ["confirmed" as const, "date-only" as const],
        evidence: plain(`${item.title} ${item.date}`),
        ...(item.html_url ? { sourceUrl: item.html_url } : {}),
        sourceRevision: item.date,
      },
    ];
  });
}
export function assignmentEvents(
  raw: unknown,
  course: string,
  courseId: string,
  origin: string,
): CalendarEvent[] {
  const original = rows(raw);
  const assignments = projectAssignments(raw);
  return assignments.flatMap((item, index) => {
    const timestamp = isoTime(item.due_at);
    if (!Number.isFinite(timestamp)) return [];
    const timed = item.due_at.length > 10;
    const zoned = timed ? seoulParts(timestamp) : undefined;
    const date = zoned?.date ?? item.due_at;
    const sourceId = original[index]?.id;
    const sourceUrl = itemUrl(original[index]?.html_url, origin);
    return [
      {
        id: `assignment:${identity(`${origin}:${courseId}:${String(sourceId ?? `${index}:${item.title}`)}`)}`,
        course,
        title: item.title,
        action: "제출",
        target: item.title,
        date,
        ...(zoned ? { time: zoned.time } : {}),
        kind: "assignment" as const,
        status: timed
          ? ["confirmed" as const]
          : ["confirmed" as const, "date-only" as const],
        evidence: plain(`${item.title} ${item.due_at}`),
        ...(sourceUrl ? { sourceUrl } : {}),
        sourceRevision: item.due_at,
      },
    ];
  });
}
export function flagRelated(events: CalendarEvent[]): CalendarEvent[] {
  const seen = new Map<string, CalendarEvent>();
  const ids = new Map<string, number>();
  for (const event of events) {
    const count = ids.get(event.id) ?? 0;
    ids.set(event.id, count + 1);
    if (count) event.id = `${event.id}:copy:${count}`;
    if (!event.date) continue;
    const subject = (event.target || event.title)
      .replace(/(?:은|는|을|를|에서|까지)\s*$/g, "")
      .replace(/\s+/g, "")
      .toLowerCase();
    const key = `${event.course}\u0000${subject}`;
    const previous = seen.get(key);
    if (previous) {
      const flag: CalendarStatus =
        previous.date === event.date && previous.time === event.time
          ? "duplicate"
          : "conflict";
      if (!event.status.includes(flag)) event.status.push(flag);
      if (!previous.status.includes(flag)) previous.status.push(flag);
    } else seen.set(key, event);
  }
  return events;
}
export function validateCalendarEvents(
  raw: unknown[],
  origin?: string,
): CalendarEvent[] {
  return raw.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error();
    const event = value as Record<string, unknown>;
    for (const key of Object.keys(event))
      if (
        ![
          "id",
          "course",
          "title",
          "action",
          "target",
          "date",
          "time",
          "kind",
          "status",
          "evidence",
          "sourceUrl",
          "sourceRevision",
        ].includes(key)
      )
        throw new Error();
    for (const key of ["id", "course", "title", "evidence", "sourceRevision"])
      if (
        typeof event[key] !== "string" ||
        !event[key] ||
        event[key].length > 500 ||
        redactText(event[key]) !== event[key] ||
        /[<>]/.test(event[key])
      )
        throw new Error();
    for (const key of ["action", "target"])
      if (
        event[key] !== undefined &&
        (typeof event[key] !== "string" ||
          event[key].length > 500 ||
          redactText(event[key]) !== event[key] ||
          /[<>]/.test(event[key]))
      )
        throw new Error();
    if (
      event.date !== undefined &&
      (typeof event.date !== "string" ||
        !Number.isFinite(isoTime(event.date)) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(event.date))
    )
      throw new Error();
    if (
      event.time !== undefined &&
      (typeof event.time !== "string" ||
        !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(event.time) ||
        !event.date)
    )
      throw new Error();
    if (
      event.kind !== "announcement" &&
      event.kind !== "planner" &&
      event.kind !== "assignment"
    )
      throw new Error();
    if (
      !Array.isArray(event.status) ||
      !event.status.length ||
      event.status.some((status) => !statuses.includes(status))
    )
      throw new Error();
    if (event.sourceUrl !== undefined) {
      if (
        typeof event.sourceUrl !== "string" ||
        itemUrl(event.sourceUrl, origin) !== event.sourceUrl
      )
        throw new Error();
      const source = new URL(event.sourceUrl);
      if (source.search || source.hash) throw new Error();
    }
    return event as unknown as CalendarEvent;
  });
}
