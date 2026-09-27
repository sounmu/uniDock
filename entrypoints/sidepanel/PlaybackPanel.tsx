import { usePlaybackPanel } from "./usePlaybackPanel";
import { ScreenHeader } from "./ui/ScreenHeader";
import { StatusChip } from "./ui/StatusChip";
import { Notice } from "./ui/Notice";
import { DetailView, useDetail } from "./ui/DetailView";
import { PlaybackConfirmation } from "./screens/PlaybackConfirmation";
import type { QueryGate } from "./query-gate";

const status: Record<string, string> = {
  idle: "대기",
  starting: "시작 중",
  playing: "재생 중",
  paused: "일시정지",
  stopped: "중지됨",
  "blocked-login": "로그인 필요",
  "blocked-autoplay": "자동 재생 차단",
  failed: "실패",
};

export function PlaybackPanel({ gate }: { gate?: QueryGate }) {
  const m = usePlaybackPanel(gate);
  const { snapshot, pending, stopPending } = m;
  const { detail, open, back } = useDetail<"select">();
  const hasPlaylist = Boolean(snapshot?.current || snapshot?.queue.length);
  const courseName = (id: string) =>
    snapshot?.courses.find((course) => course.id === id)?.name ??
    "과목 확인 필요";
  const resumable = [
    "paused",
    "blocked-login",
    "blocked-autoplay",
    "failed",
  ].includes(snapshot?.status ?? "");

  return (
    <section
      className="playback-panel"
      aria-label="자동 재생"
      aria-live="polite"
      aria-busy={pending}
    >
      <div hidden={detail !== null}>
        <ScreenHeader
          title={`자동 재생 · ${status[snapshot?.status ?? "idle"]}`}
          action={
            <div className="header-actions">
              {hasPlaylist ? (
                <button
                  className="btn-secondary"
                  disabled={stopPending}
                  onClick={() =>
                    void m.run({ version: 1, type: "PLAYBACK_STOP_ALL" })
                  }
                >
                  자동 재생 끄기
                </button>
              ) : (
                <button
                  className="btn-primary"
                  disabled={pending || !snapshot}
                  onClick={() => open("select")}
                >
                  영상 선택
                </button>
              )}
              <button
                className="btn-primary"
                disabled={pending}
                onClick={() =>
                  void m.run({ version: 1, type: "PLAYBACK_REFRESH" })
                }
              >
                새로고침
              </button>
            </div>
          }
        />

        {snapshot?.status === "blocked-login" && (
          <Notice error>
            <strong>LMS 로그인이 필요합니다.</strong>
            <p>
              재생목록은 보존됩니다. LMS에 다시 로그인한 뒤 재개를 누르세요.
            </p>
            <div className="tools">
              <a
                className="btn-secondary"
                href="https://mylms.korea.ac.kr/"
                target="_blank"
                rel="noreferrer"
              >
                LMS 로그인 열기
              </a>
              <button
                className="btn-primary"
                disabled={pending}
                onClick={() =>
                  void m.run({ version: 1, type: "PLAYBACK_RESUME" })
                }
              >
                로그인 확인 후 재개
              </button>
            </div>
          </Notice>
        )}

        {resumable && snapshot?.status !== "blocked-login" && hasPlaylist && (
          <Notice error={snapshot?.status !== "paused"}>
            <p>재생목록이 멈췄습니다. 강의 탭을 확인한 뒤 재개하세요.</p>
            <button
              className="btn-primary"
              disabled={pending}
              onClick={() =>
                void m.run({ version: 1, type: "PLAYBACK_RESUME" })
              }
            >
              자동 재생 재개
            </button>
          </Notice>
        )}

        <h3>현재 재생</h3>
        {snapshot?.current ? (
          <div className="playback-current">
            <div>
              <strong>
                {snapshot.labels?.[snapshot.current.id] ??
                  "영상 제목 확인 필요"}
              </strong>
              <small>{courseName(snapshot.current.courseId)}</small>
            </div>
            <StatusChip>{status[snapshot.status] ?? "상태 확인"}</StatusChip>
          </div>
        ) : (
          <p className="hint">재생 중인 영상이 없습니다.</p>
        )}

        <h3>다음 영상</h3>
        {snapshot?.queue.length ? (
          <ol className="playback-queue">
            {snapshot.queue.map((item, index) => (
              <li key={item.id}>
                <span className="playback-order" aria-hidden="true">
                  {index + 1}
                </span>
                <div>
                  <strong>
                    {snapshot.labels?.[item.id] ?? "영상 제목 확인 필요"}
                  </strong>
                  <small>{courseName(item.courseId)}</small>
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <p className="hint">대기 중인 영상이 없습니다.</p>
        )}

        <details className="guidance">
          <summary>안내 및 로컬 데이터</summary>
          <p className="hint">
            정상 속도(1배속)로 재생하며, 강의 탭이 숨겨지면 안전하게 멈춥니다.
            브라우저가 소리 있는 자동 재생을 차단하면 무음으로 한 번
            재시도합니다. 소리는 강의 플레이어에서 직접 켤 수 있습니다. 영상
            종료와 LMS 이수 인정은 별개입니다.
          </p>
          <button
            className="btn-secondary"
            onClick={() => m.setDeletePrompt(true)}
          >
            로컬 데이터 모두 삭제
          </button>
          {m.deletePrompt && (
            <div className="notice">
              <p>저장된 재생목록과 상태를 모두 삭제합니다.</p>
              <button
                className="btn-primary"
                disabled={pending}
                onClick={() =>
                  void m
                    .run({ version: 1, type: "LOCAL_DATA_DELETE_ALL" })
                    .then((ok) => {
                      if (ok) m.setDeletePrompt(false);
                    })
                }
              >
                삭제 확인
              </button>
              <button
                className="btn-secondary"
                onClick={() => m.setDeletePrompt(false)}
              >
                취소
              </button>
            </div>
          )}
        </details>
      </div>

      {detail === "select" && (
        <DetailView title="영상 선택" onBack={back}>
          <PlaybackConfirmation model={m} onComplete={back} />
        </DetailView>
      )}
      {m.error && <Notice error>{m.error}</Notice>}
    </section>
  );
}
