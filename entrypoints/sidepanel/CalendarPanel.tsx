import { useEffect, useMemo, useRef, useState } from "react";
import type { CalendarEvent, CalendarStatus } from "../../src/calendar/events";
import type { ErrorCode } from "../../src/protocol";
import {
  playbackCommand,
  type CalendarOverrideView,
  type PlaybackSnapshot,
} from "../../src/playback/bridge";

type DisplayEvent = CalendarEvent & {
  playbackKind?: "viewing-deadline" | "reservation";
};

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"] as const;
const SEOUL_MS = 9 * 60 * 60 * 1000;
function playbackDate(value: number): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const part = (key: string) =>
    parts.find(({ type }) => type === key)?.value ?? "";
  return {
    date: `${part("year")}-${part("month")}-${part("day")}`,
    time: `${part("hour")}:${part("minute")}`,
  };
}

const statusLabels: Record<CalendarStatus, string> = {
  confirmed: "확정",
  ambiguous: "확인 필요",
  changed: "변경됨",
  cancelled: "취소됨",
  duplicate: "중복",
  conflict: "일정 충돌",
  "date-only": "날짜만",
};

const calendarErrors: Partial<Record<ErrorCode, string>> = {
  LOGIN_REQUIRED:
    "LMS 로그인이 필요합니다. LMS에서 로그인한 뒤 다시 조회하세요.",
  NETWORK: "LMS에 연결하지 못했습니다. 잠시 후 다시 시도하세요.",
  TIMEOUT: "조회 시간이 초과되었습니다. 다시 시도하세요.",
};

export function todayKorea(now = Date.now()): string {
  const d = new Date(now + SEOUL_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

export function currentMonthKorea(now = Date.now()): string {
  return todayKorea(now).slice(0, 7);
}

export function navigateMonth(month: string, direction: -1 | 1): string {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7)) + direction;
  if (m < 1) return `${y - 1}-12`;
  if (m > 12) return `${y + 1}-01`;
  return `${y}-${String(m).padStart(2, "0")}`;
}

function monthLabel(month: string): string {
  return `${month.slice(0, 4)}년 ${Number(month.slice(5, 7))}월`;
}

export function monthRange(month: string): { start: string; end: string } {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return {
    start: `${month}-01`,
    end: `${month}-${String(lastDay).padStart(2, "0")}`,
  };
}

interface DayCell {
  date: string;
  day: number;
  inMonth: boolean;
}

function fmtDate(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

export function monthCells(month: string): DayCell[] {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  const lastDate = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const startDow = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const cells: DayCell[] = [];
  for (let i = startDow - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1, -i));
    cells.push({ date: fmtDate(d), day: d.getUTCDate(), inMonth: false });
  }
  for (let d = 1; d <= lastDate; d++) {
    cells.push({
      date: `${month}-${String(d).padStart(2, "0")}`,
      day: d,
      inMonth: true,
    });
  }
  let next = 1;
  while (cells.length % 7 !== 0) {
    const d = new Date(Date.UTC(y, m, next++));
    cells.push({ date: fmtDate(d), day: d.getUTCDate(), inMonth: false });
  }
  return cells;
}

export interface CalendarPanelProps {
  events: readonly CalendarEvent[];
  loading: boolean;
  errorCode?: ErrorCode;
  onLoadMonth: (month: string) => void;
  postingStart: string;
  postingEnd: string;
  onPostingChange: (field: "start" | "end", value: string) => void;
}

export function CalendarPanel({
  events,
  loading,
  errorCode,
  onLoadMonth,
  postingStart,
  postingEnd,
  onPostingChange,
}: CalendarPanelProps) {
  const [month, setMonth] = useState(() => currentMonthKorea());
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [courseFilter, setCourseFilter] = useState("");
  const [playback, setPlayback] = useState<PlaybackSnapshot | null>(null);
  const [overrides, setOverrides] = useState<readonly CalendarOverrideView[]>(
    [],
  );
  const [overrideError, setOverrideError] = useState("");
  const revision = useRef(0);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      const result = await playbackCommand({
        version: 1,
        type: "PLAYBACK_STATUS",
      });
      if (active && result.status === "success") setPlayback(result.snapshot);
    };
    void refresh();
    if (typeof chrome === "undefined" || !chrome.runtime?.onMessage)
      return () => {
        active = false;
      };
    const updated = (
      message: unknown,
      sender: chrome.runtime.MessageSender,
    ) => {
      if (
        sender.id === chrome.runtime.id &&
        (sender.url === undefined ||
          sender.url === chrome.runtime.getURL("background.js")) &&
        message !== null &&
        typeof message === "object" &&
        (message as Record<string, unknown>).version === 1 &&
        (message as Record<string, unknown>).type === "PLAYBACK_UPDATED"
      )
        void refresh();
    };
    chrome.runtime.onMessage.addListener(updated);
    return () => {
      active = false;
      chrome.runtime.onMessage.removeListener(updated);
    };
  }, []);
  useEffect(() => {
    const current = ++revision.current;
    if (loading || errorCode) return;
    void playbackCommand({
      version: 1,
      type: "CALENDAR_OVERRIDES_GET",
      sources: events.map(({ id, sourceRevision }) => ({ id, sourceRevision })),
    }).then((result) => {
      if (current !== revision.current) return;
      if (result.status === "success") {
        setOverrides(result.snapshot.calendarOverrides);
        setOverrideError("");
      } else
        setOverrideError(
          `저장된 일정 설정을 불러오지 못했습니다 (${result.code}).`,
        );
    });
    return () => {
      revision.current++;
    };
  }, [events, loading, errorCode]);
  async function changeOverride(
    command: Parameters<typeof playbackCommand>[0],
  ) {
    setSaving(true);
    const result = await playbackCommand(command);
    setSaving(false);
    if (result.status === "success") {
      setOverrides(result.snapshot.calendarOverrides);
      setOverrideError("");
      setEditDraft(null);
    } else
      setOverrideError(`일정 설정을 저장하지 못했습니다 (${result.code}).`);
  }
  const [editDraft, setEditDraft] = useState<{
    id: string;
    date: string;
    time: string;
  } | null>(null);
  const mounted = useRef(false);

  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      onLoadMonth(month);
    }
  }, []);

  const effectiveEvents = useMemo(
    () =>
      events.map((event) => {
        const override = overrides.find((item) => item.id === event.id);
        if (!override || override.excluded || override.confirmationRequired)
          return event;
        return {
          ...event,
          date: override.date,
          time: override.time,
          status: [
            "confirmed" as const,
            ...event.status.filter(
              (item) =>
                item !== "ambiguous" &&
                item !== "confirmed" &&
                item !== "date-only",
            ),
            ...(!override.time ? ["date-only" as const] : []),
          ],
        };
      }),
    [events, overrides],
  );
  const playbackMarkers = useMemo<DisplayEvent[]>(() => {
    const scheduled = [
      ...(playback?.queue ?? []),
      ...(playback?.active ? [playback.active] : []),
    ];
    return scheduled.flatMap((item) => {
      const course =
        playback?.courses?.find(({ id }) => id === item.courseId)?.name ??
        "과목 확인 필요";
      const title = playback?.labels?.[item.id] ?? "영상 제목 확인 필요";
      return (
        [
          [
            "viewing-deadline",
            item.deadline,
            "시청 기한",
            "사용자가 확인한 영상 시청 기한",
          ],
          [
            "reservation",
            item.startAt,
            "예약 재생",
            "시청 기한을 기준으로 계산한 재생 예약 시각",
          ],
        ] as const
      ).map(([playbackKind, timestamp, action, evidence]) => ({
        id: `playback:${item.id}:${playbackKind}`,
        course,
        title,
        action,
        ...playbackDate(timestamp),
        kind: "planner" as const,
        status: ["confirmed" as const],
        evidence,
        sourceRevision: new Date(timestamp).toISOString(),
        playbackKind,
      }));
    });
  }, [playback]);
  const displayEvents = useMemo(
    () => [...effectiveEvents, ...playbackMarkers],
    [effectiveEvents, playbackMarkers],
  );

  const filteredEvents = useMemo(
    () =>
      displayEvents.filter(
        (e) =>
          !overrides.some(
            (item) =>
              item.id === e.id && item.excluded && !item.confirmationRequired,
          ) &&
          (!courseFilter || e.course === courseFilter),
      ),
    [displayEvents, overrides, courseFilter],
  );

  const eventsByDate = useMemo(() => {
    const map = new Map<string, DisplayEvent[]>();
    for (const event of filteredEvents) {
      if (event.date) {
        const list = map.get(event.date);
        if (list) list.push(event);
        else map.set(event.date, [event]);
      }
    }
    return map;
  }, [filteredEvents]);

  const undatedEvents = useMemo(
    () => filteredEvents.filter((e) => !e.date),
    [filteredEvents],
  );

  const courses = useMemo(() => {
    const set = new Set<string>();
    for (const event of displayEvents) if (event.course) set.add(event.course);
    return [...set].sort();
  }, [displayEvents]);

  const cells = useMemo(() => monthCells(month), [month]);
  const today = todayKorea();

  function navigate(direction: -1 | 1) {
    const next = navigateMonth(month, direction);
    setMonth(next);
    setSelectedDay(null);
    setEditDraft(null);
    onLoadMonth(next);
  }

  function handleStartEdit(event: CalendarEvent) {
    setEditDraft({
      id: event.id,
      date: event.date ?? "",
      time: event.time ?? "",
    });
  }

  function handleConfirmEdit() {
    if (!editDraft?.date) return;
    const event = events.find((item) => item.id === editDraft.id);
    if (event)
      void changeOverride({
        version: 1,
        type: "CALENDAR_OVERRIDE_SET",
        override: {
          id: event.id,
          sourceRevision: event.sourceRevision,
          excluded: false,
          date: editDraft.date,
          ...(editDraft.time ? { time: editDraft.time } : {}),
        },
      });
  }

  const selectedEvents = selectedDay
    ? (eventsByDate.get(selectedDay) ?? [])
    : [];
  const excludedList = events.filter((e) =>
    overrides.some((item) => item.id === e.id && item.excluded),
  );
  const orphanedOverrides = useMemo(() => {
    const visible = new Set(events.map(({ id }) => id));
    return overrides.filter(({ id }) => !visible.has(id));
  }, [events, overrides]);

  function renderEventList(list: readonly DisplayEvent[]) {
    return (
      <ul>
        {list.map((event) => (
          <EventCard
            key={event.id}
            event={event}
            playbackKind={event.playbackKind}
            editing={editDraft?.id === event.id ? editDraft : null}
            edited={overrides.some(
              (item) => item.id === event.id && !item.excluded,
            )}
            stale={overrides.some(
              (item) => item.id === event.id && item.confirmationRequired,
            )}
            saving={saving}
            onExclude={() =>
              void changeOverride({
                version: 1,
                type: "CALENDAR_OVERRIDE_SET",
                override: {
                  id: event.id,
                  sourceRevision: event.sourceRevision,
                  excluded: true,
                },
              })
            }
            onStartEdit={() => handleStartEdit(event)}
            onConfirmEdit={handleConfirmEdit}
            onCancelEdit={() => setEditDraft(null)}
            onClearEdit={() =>
              void changeOverride({
                version: 1,
                type: "CALENDAR_OVERRIDE_REMOVE",
                id: event.id,
              })
            }
            onEditChange={(field, value) =>
              setEditDraft((prev) =>
                prev ? { ...prev, [field]: value } : null,
              )
            }
          />
        ))}
      </ul>
    );
  }

  return (
    <section className="calendar-panel" aria-label="일정 캘린더">
      <div className="calendar-header">
        <button
          className="secondary"
          onClick={() => navigate(-1)}
          aria-label="이전 달"
        >
          ←
        </button>
        <h3>{monthLabel(month)}</h3>
        <button
          className="secondary"
          onClick={() => navigate(1)}
          aria-label="다음 달"
        >
          →
        </button>
      </div>

      <p className="hint">
        표시 월과 별개로 공지 게시일 범위를 지정합니다. 한국 시간 기준입니다.
      </p>
      <div className="date-fields">
        <label className="field">
          공지 게시 시작일
          <input
            type="date"
            value={postingStart}
            onChange={(e) => onPostingChange("start", e.target.value)}
          />
        </label>
        <label className="field">
          공지 게시 종료일
          <input
            type="date"
            value={postingEnd}
            onChange={(e) => onPostingChange("end", e.target.value)}
          />
        </label>
      </div>
      {postingStart > postingEnd && (
        <p className="filter-error">게시 종료일은 시작일 이후여야 합니다.</p>
      )}
      <button
        className="secondary"
        disabled={loading || postingStart > postingEnd}
        onClick={() => onLoadMonth(month)}
      >
        새로고침
      </button>
      <div className="calendar-filters">
        <label className="field">
          과목
          <select
            value={courseFilter}
            onChange={(e) => setCourseFilter(e.target.value)}
          >
            <option value="">전체 과목</option>
            {courses.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <div className="calendar-view-toggle">
          <button
            className="secondary"
            aria-pressed={viewMode === "grid"}
            onClick={() => setViewMode("grid")}
          >
            달력
          </button>
          <button
            className="secondary"
            aria-pressed={viewMode === "list"}
            onClick={() => setViewMode("list")}
          >
            목록
          </button>
        </div>
      </div>

      <div aria-live="polite" aria-busy={loading || saving}>
        {overrideError && <p className="notice error">{overrideError}</p>}
        {loading && <div className="notice">일정을 불러오고 있습니다…</div>}

        {errorCode && !loading && (
          <div className="notice error">
            <strong>
              {errorCode === "LOGIN_REQUIRED" ? "로그인 필요" : "조회 안내"}
            </strong>
            <p>
              {calendarErrors[errorCode] ??
                "일정을 불러오지 못했습니다. 다시 시도하세요."}
            </p>
          </div>
        )}

        {!loading && !errorCode && viewMode === "grid" && (
          <>
            <div
              className="calendar-grid"
              role="grid"
              aria-label={monthLabel(month)}
            >
              <div className="calendar-weekdays" role="row">
                {WEEKDAYS.map((day) => (
                  <div
                    key={day}
                    className="calendar-weekday"
                    role="columnheader"
                  >
                    {day}
                  </div>
                ))}
              </div>
              {Array.from({ length: Math.ceil(cells.length / 7) }, (_, row) => (
                <div key={row} className="calendar-row" role="row">
                  {cells.slice(row * 7, row * 7 + 7).map((cell) => {
                    const count = eventsByDate.get(cell.date)?.length ?? 0;
                    const isToday = cell.date === today;
                    return (
                      <button
                        key={cell.date}
                        className={`day-cell${cell.inMonth ? "" : " out-of-month"}${isToday ? " today" : ""}`}
                        role="gridcell"
                        aria-pressed={cell.date === selectedDay}
                        aria-label={`${cell.day}일${count > 0 ? ` ${count}건` : ""}${isToday ? " 오늘" : ""}`}
                        onClick={() => {
                          setSelectedDay((prev) =>
                            prev === cell.date ? null : cell.date,
                          );
                          setEditDraft(null);
                        }}
                      >
                        <span className="day-number">{cell.day}</span>
                        {count > 0 && (
                          <span className="day-count">{count}</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>

            {selectedDay && (
              <div className="day-details">
                <h4>
                  {Number(selectedDay.slice(8, 10))}일 일정
                  {selectedDay === today ? " (오늘)" : ""}
                </h4>
                {selectedEvents.length === 0 ? (
                  <div className="notice">이 날짜에 일정이 없습니다.</div>
                ) : (
                  renderEventList(selectedEvents)
                )}
              </div>
            )}

            {undatedEvents.length > 0 && (
              <div className="undated-events">
                <h4>날짜 미정 ({undatedEvents.length}건)</h4>
                {renderEventList(undatedEvents)}
              </div>
            )}
          </>
        )}

        {!loading && !errorCode && viewMode === "list" && (
          <div className="calendar-list">
            {filteredEvents.length === 0 ? (
              <div className="notice">
                {events.length === 0
                  ? "이 달에 조회된 일정이 없습니다."
                  : "조건에 맞는 일정이 없습니다."}
              </div>
            ) : (
              renderEventList(
                filteredEvents.slice().sort((a, b) => {
                  if (!a.date && !b.date) return 0;
                  if (!a.date) return 1;
                  if (!b.date) return -1;
                  return a.date.localeCompare(b.date);
                }),
              )
            )}
          </div>
        )}

        {!loading && !errorCode && excludedList.length > 0 && (
          <div className="excluded-section">
            <h4>제외된 항목 ({excludedList.length}건)</h4>
            <ul>
              {excludedList.map((event) => (
                <li key={event.id}>
                  <div className="item-body">
                    <strong>{event.title || "제목 없음"}</strong>
                    <p>{event.course}</p>
                    <button
                      className="secondary"
                      disabled={saving}
                      onClick={() =>
                        void changeOverride({
                          version: 1,
                          type: "CALENDAR_OVERRIDE_REMOVE",
                          id: event.id,
                        })
                      }
                    >
                      복원
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        {!loading && !errorCode && orphanedOverrides.length > 0 && (
          <div className="notice" role="status">
            <h4>
              현재 조회에서 찾을 수 없는 일정 설정 ({orphanedOverrides.length}
              건)
            </h4>
            <p>
              조회 범위를 넓히거나 LMS 원문을 확인하세요. 기존 수정·제외 기록은
              자동으로 삭제되지 않습니다.
            </p>
            <ul>
              {orphanedOverrides.map((override) => (
                <li key={override.id}>
                  {override.excluded
                    ? "이전에 제외한 일정"
                    : `${override.date}${override.time ? ` ${override.time}` : ""}로 수정한 일정`}
                  <button
                    className="secondary"
                    disabled={saving}
                    onClick={() =>
                      void changeOverride({
                        version: 1,
                        type: "CALENDAR_OVERRIDE_REMOVE",
                        id: override.id,
                      })
                    }
                  >
                    이전 설정 삭제
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {!loading && !errorCode && (
          <p className="count">
            조회 완료 · {displayEvents.length}개 일정
            {filteredEvents.length !== displayEvents.length
              ? ` 중 ${filteredEvents.length}개 표시`
              : ""}{" "}
            · 한국 시간
          </p>
        )}
      </div>
    </section>
  );
}

function EventCard({
  event,
  playbackKind,
  editing,
  edited,
  stale,
  saving,
  onExclude,
  onStartEdit,
  onConfirmEdit,
  onCancelEdit,
  onClearEdit,
  onEditChange,
}: {
  event: CalendarEvent;
  playbackKind?: "viewing-deadline" | "reservation";
  editing: { id: string; date: string; time: string } | null;
  edited: boolean;
  stale: boolean;
  saving: boolean;
  onExclude: () => void;
  onStartEdit: () => void;
  onConfirmEdit: () => void;
  onCancelEdit: () => void;
  onClearEdit: () => void;
  onEditChange: (field: "date" | "time", value: string) => void;
}) {
  return (
    <li className="event-card">
      <div className="item-body">
        <strong>
          {event.sourceUrl ? (
            <a
              className="item-title-link"
              href={event.sourceUrl}
              target="_blank"
              rel="noreferrer"
            >
              {event.title || "제목 없음"}
            </a>
          ) : (
            event.title || "제목 없음"
          )}
        </strong>
        <p>{event.course}</p>
        {event.date && (
          <p>
            {event.date}
            {event.time ? ` ${event.time}` : ""}
          </p>
        )}
        {event.action && <p>동작: {event.action}</p>}
        {event.target && <p>대상: {event.target}</p>}
        <p className="evidence-text">근거: {event.evidence}</p>
        {stale && (
          <p>
            원본이 변경되었습니다. LMS에서 확인 후 다시 수정하거나 제외하세요.
          </p>
        )}
        <div className="event-statuses">
          {event.status.map((s) => (
            <span key={s} className={`event-status status-${s}`}>
              {statusLabels[s]}
            </span>
          ))}
        </div>
        <span className="item-badge" data-playback-kind={playbackKind}>
          {playbackKind === "viewing-deadline"
            ? "영상 시청 기한"
            : playbackKind === "reservation"
              ? "영상 예약 시각"
              : event.kind === "announcement"
                ? "공지사항"
                : event.kind === "assignment"
                  ? "과제"
                  : "학사 일정"}
          {edited ? " · 수정됨" : ""}
        </span>
        {playbackKind ? null : editing ? (
          <div className="event-edit-form">
            <label className="field">
              날짜
              <input
                type="date"
                value={editing.date}
                onChange={(e) => onEditChange("date", e.target.value)}
              />
            </label>
            <label className="field">
              시각
              <input
                type="time"
                value={editing.time}
                onChange={(e) => onEditChange("time", e.target.value)}
              />
            </label>
            <div className="recording-actions">
              <button
                className="secondary"
                disabled={saving || !editing.date}
                onClick={onConfirmEdit}
              >
                확인
              </button>
              <button className="secondary" onClick={onCancelEdit}>
                취소
              </button>
            </div>
          </div>
        ) : (
          <div className="recording-actions">
            <button className="secondary" onClick={onStartEdit}>
              수정
            </button>
            <button className="secondary" disabled={saving} onClick={onExclude}>
              제외
            </button>
            {edited && (
              <button className="secondary" onClick={onClearEdit}>
                원래대로
              </button>
            )}
          </div>
        )}
      </div>
    </li>
  );
}
