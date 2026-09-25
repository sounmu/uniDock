import { useEffect, useState } from "react";
import {
  playbackCommand,
  type PlaybackCommand,
  type PlaybackSnapshot,
} from "../../src/playback/bridge";
import { DEFAULT_PLAYBACK_SETTINGS } from "../../src/playback/scheduler";
import { queryActive } from "../../src/transport";

const reason: Record<string, string> = {
  disabled: "자동 재생 꺼짐",
  course_not_opted_in: "과목 미선택",
  unknown_deadline: "마감 시각 없음",
  date_only_deadline: "마감 날짜만 있음",
  invalid_deadline: "마감 시각 확인 필요",
  unknown_duration: "영상 길이 확인 필요",
  unknown_completion: "이수 여부 확인 필요",
  complete: "LMS 완료",
  missed_deadline: "마감 지남",
  infeasible: "시간 내 재생 불가",
};
const status: Record<string, string> = {
  idle: "대기",
  scheduled: "예약됨",
  starting: "시작 중",
  playing: "재생 중",
  paused: "일시정지",
  stopped: "중지됨",
  "blocked-login": "로그인 필요",
  "blocked-autoplay": "자동 재생 차단",
  "confirmation-required": "수동 확인 필요",
  failed: "실패",
};
const stamp = (time: number) =>
  new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    dateStyle: "short",
    timeStyle: "short",
  }).format(time);
export function PlaybackPanel() {
  const [snapshot, setSnapshot] = useState<PlaybackSnapshot | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [confirm, setConfirm] = useState<{
    handle: string;
    title: string;
  } | null>(null);
  const [recordings, setRecordings] = useState<
    { title: string; module: string; lmsHandle: string; launchHandle: string }[]
  >([]);
  const [course, setCourse] = useState("");
  const [deadline, setDeadline] = useState("");
  const [duration, setDuration] = useState("");
  const [deletePrompt, setDeletePrompt] = useState(false);
  async function run(command: PlaybackCommand) {
    setPending(true);
    const result = await playbackCommand(command);
    setPending(false);
    if (result.status === "success") {
      setSnapshot(result.snapshot);
      setError("");
    } else
      setError(
        `재생 요청 실패 (${result.code}). LMS 로그인 및 탭 상태를 확인하세요.`,
      );
    return result.status === "success";
  }
  useEffect(() => {
    void run({ version: 1, type: "PLAYBACK_STATUS" });
    if (typeof chrome === "undefined" || !chrome.runtime?.onMessage) return;
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
        void run({ version: 1, type: "PLAYBACK_STATUS" });
    };
    chrome.runtime.onMessage.addListener(updated);
    return () => chrome.runtime.onMessage.removeListener(updated);
  }, []);
  const settings = snapshot?.settings ?? DEFAULT_PLAYBACK_SETTINGS;
  function configure(update: Partial<typeof settings>) {
    void run({
      version: 1,
      type: "PLAYBACK_CONFIGURE",
      settings: { ...settings, ...update },
    });
  }
  async function loadRecordings() {
    if (!course) return;
    setPending(true);
    const result = await queryActive({
      version: 1,
      type: "RECORDINGS_LIST",
      course,
    });
    setPending(false);
    if (result.status === "success" && "recordings" in result) {
      setRecordings(result.recordings);
      setError("");
    } else setError("녹화 후보를 불러오지 못했습니다. LMS 탭에서 확인하세요.");
  }
  return (
    <section
      className="playback-panel"
      aria-label="자동 재생"
      aria-live="polite"
      aria-busy={pending}
    >
      <div className="toolbar">
        <h3>자동 재생 · {status[snapshot?.status ?? "idle"]}</h3>
        <button
          disabled={pending}
          onClick={() => void run({ version: 1, type: "PLAYBACK_REFRESH" })}
        >
          상태 새로고침
        </button>
      </div>
      <p className="hint">
        기본값은 꺼짐입니다. 선택한 과목만 보이는 LMS 탭에서 정상 속도(1배속)로
        재생합니다. PC가 꺼져 있으면 재생할 수 없습니다.
      </p>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      <label className="remaining-toggle">
        <input
          type="checkbox"
          checked={settings.enabled}
          disabled={pending || !snapshot}
          onChange={(e) => configure({ enabled: e.target.checked })}
        />{" "}
        자동 재생 사용
      </label>
      <fieldset disabled={pending || !snapshot} className="playback-settings">
        <legend>과목별 설정</legend>
        {snapshot?.courses.length ? (
          snapshot.courses.map((item) => (
            <label className="remaining-toggle" key={item.id}>
              <input
                type="checkbox"
                checked={settings.courseIds.includes(item.id)}
                onChange={(e) =>
                  configure({
                    courseIds: e.target.checked
                      ? [...settings.courseIds, item.id]
                      : settings.courseIds.filter((id) => id !== item.id),
                  })
                }
              />
              {item.name}
            </label>
          ))
        ) : (
          <p className="hint">
            LMS에서 과목을 찾지 못했습니다. 로그인 후 새로고침하세요.
          </p>
        )}
        <div className="playback-fields">
          {(
            [
              ["windowStartHour", "시작 시각 (한국 시간)", 0, 23],
              ["windowEndHour", "종료 시각 (한국 시간)", 1, 24],
              ["leadHours", "마감 전 여유 (시간)", 0, 168],
              ["marginMinutes", "재생 여유 (분)", 0, 120],
            ] as const
          ).map(([key, label, min, max]) => (
            <label className="field" key={key}>
              {label}
              <input
                type="number"
                min={min}
                max={max}
                value={settings[key]}
                onChange={(e) => {
                  const value = Number(e.target.value);
                  if (
                    e.target.value !== "" &&
                    value >= min &&
                    value <= max &&
                    (key !== "windowStartHour" ||
                      value < settings.windowEndHour) &&
                    (key !== "windowEndHour" ||
                      value > settings.windowStartHour)
                  )
                    configure({ [key]: value });
                }}
              />
            </label>
          ))}
        </div>
      </fieldset>
      <h4>재생 대기열</h4>
      <p>
        현재:{" "}
        {snapshot?.active
          ? `${snapshot.labels?.[snapshot.active.id] ?? "영상 제목 확인 필요"} · ${stamp(snapshot.active.startAt)} · 재생 상태 ${status[snapshot.status]} · LMS 이수 ${snapshot.active.credit === "credited" ? "확인됨" : snapshot.active.credit === "not_credited" ? "미확인" : "확인 필요"}`
          : "없음"}
      </p>
      <p>
        다음:{" "}
        {snapshot?.queue[0]
          ? `${snapshot.labels?.[snapshot.queue[0].id] ?? "영상 제목 확인 필요"} · ${stamp(snapshot.queue[0].startAt)}`
          : "없음"}
      </p>
      {snapshot?.finishedIds.length ? (
        <p>
          재생 종료 {snapshot.finishedIds.length}건 · LMS 이수는 별도로
          확인하세요.
        </p>
      ) : null}
      <ul>
        {snapshot?.queue.map((item) => (
          <li key={item.id}>
            <div className="item-body">
              {snapshot.labels?.[item.id] ?? "영상 제목 확인 필요"} · 예약{" "}
              {stamp(item.startAt)} ~ {stamp(item.finishAt)} · 시청 기한{" "}
              {stamp(item.deadline)} · 여유{" "}
              {item.margin === "full" ? "확보" : "축소"}
              <div>
                <button
                  className="secondary"
                  disabled={pending}
                  onClick={() =>
                    void run({
                      version: 1,
                      type: "PLAYBACK_CANCEL",
                      id: item.id,
                    })
                  }
                >
                  예약 취소
                </button>
              </div>
            </div>
          </li>
        ))}
      </ul>
      <h4>대기 사유</h4>
      <ul>
        {snapshot?.blocked.map((item) => (
          <li key={item.id}>
            {snapshot.labels?.[item.id] ?? "영상 제목 확인 필요"} ·{" "}
            {reason[item.reason]}
            {item.requiresManualConfirmation
              ? " · 영상 정보 수동 확인 필요"
              : ""}
          </li>
        ))}
      </ul>
      <div className="recording-actions">
        <button
          disabled={pending || !settings.enabled}
          onClick={() => void run({ version: 1, type: "PLAYBACK_PAUSE" })}
        >
          일시정지
        </button>
        <button
          disabled={pending || !settings.enabled}
          onClick={() => void run({ version: 1, type: "PLAYBACK_RESUME" })}
        >
          재개
        </button>
        <button
          disabled={pending}
          onClick={() => void run({ version: 1, type: "PLAYBACK_STOP_ALL" })}
        >
          전체 중지
        </button>
      </div>
      <h4>영상 정보 수동 확인</h4>
      <p className="hint">
        LMS에서 영상의 마감 시각, 길이, 미이수 상태를 직접 확인한 뒤 해당 녹화
        후보를 선택하세요. 재생 종료만으로 LMS 이수를 추정하지 않습니다.
      </p>
      <label className="field">
        확인할 과목
        <select
          value={course}
          onChange={(e) => {
            setCourse(e.target.value);
            setRecordings([]);
            setConfirm(null);
          }}
        >
          <option value="">과목 선택</option>
          {snapshot?.courses.map((item) => (
            <option key={item.id} value={item.name}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      <button
        disabled={pending || !course}
        onClick={() => void loadRecordings()}
      >
        녹화 후보 조회
      </button>
      <ul>
        {recordings.map((item) => (
          <li key={item.lmsHandle}>
            <div className="item-body">
              {item.module} · {item.title}
              <div>
                <button
                  className="secondary"
                  disabled={pending || !settings.enabled || !item.launchHandle}
                  onClick={() =>
                    setConfirm({ handle: item.launchHandle, title: item.title })
                  }
                >
                  정보 확인
                </button>
                {!item.launchHandle && (
                  <p>영상 항목을 확인할 수 없어 예약할 수 없습니다.</p>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>
      {confirm && (
        <div className="notice">
          <h4>{confirm.title}</h4>
          <label className="field">
            LMS 마감 시각 (한국 시간)
            <input
              type="datetime-local"
              value={deadline}
              onChange={(e) => setDeadline(e.target.value)}
            />
          </label>
          <label className="field">
            영상 길이 (분)
            <input
              type="number"
              min="1"
              max="1440"
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
            />
          </label>
          <button
            disabled={
              pending ||
              !deadline ||
              !(Number(duration) > 0 && Number(duration) <= 1440)
            }
            onClick={() => {
              const iso = new Date(`${deadline}:00+09:00`).toISOString();
              void run({
                version: 1,
                type: "PLAYBACK_CONFIRM",
                handle: confirm.handle,
                deadline: iso,
                durationMinutes: Number(duration),
                completion: "incomplete",
              }).then((ok) => {
                if (ok) setConfirm(null);
              });
            }}
          >
            LMS 미이수 확인 후 예약
          </button>
        </div>
      )}
      <div className="delete-data">
        <button className="secondary" onClick={() => setDeletePrompt(true)}>
          로컬 데이터 모두 삭제
        </button>
        {deletePrompt && (
          <div className="notice">
            <p>저장된 일정 수정·제외 및 재생 설정과 기록을 모두 삭제합니다.</p>
            <button
              disabled={pending}
              onClick={() =>
                void run({ version: 1, type: "LOCAL_DATA_DELETE_ALL" }).then(
                  (ok) => {
                    if (ok) {
                      setDeletePrompt(false);
                      setRecordings([]);
                    }
                  },
                )
              }
            >
              삭제 확인
            </button>
            <button
              className="secondary"
              onClick={() => setDeletePrompt(false)}
            >
              취소
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
