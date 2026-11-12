import { useEffect, useRef } from "react";
import { usePlaybackPanel, type PlaybackEntry } from "./usePlaybackPanel";
import { ScreenHeader } from "./ui/ScreenHeader";
import { Notice } from "./ui/Notice";
import { DetailView, useDetail } from "./ui/DetailView";
import { PlaybackConfirmation } from "./screens/PlaybackConfirmation";
import type { QueryGate } from "./query-gate";
import { Icon } from "./ui/icons";
import { courseFolderName } from "../../src/security/download";

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

export function PlaybackPanel({
  gate,
  entry,
}: {
  readonly gate?: QueryGate;
  readonly entry?: PlaybackEntry;
}) {
  const m = usePlaybackPanel(gate, entry);
  const { snapshot, pending, stopPending } = m;
  const { detail, open, back } = useDetail<"select">();
  const openedEntry = useRef<PlaybackEntry | undefined>(undefined);
  useEffect(() => {
    if (!entry || openedEntry.current === entry) return;
    openedEntry.current = entry;
    open("select");
  }, [entry, open]);
  const hasPlaylist = Boolean(snapshot?.current || snapshot?.queue.length);
  const playlist = snapshot?.current
    ? [snapshot.current, ...snapshot.queue]
    : snapshot?.queue ?? [];
  const courseName = (id: string) =>
    courseFolderName(
      snapshot?.courses.find((course) => course.id === id)?.name ??
        "과목 확인 필요",
    );
  const resumable = [
    "stopped",
    "blocked-login",
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
              {hasPlaylist && snapshot?.status !== "stopped" ? (
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
                  onClick={() => {
                    open("select");
                    void m.loadCourses();
                  }}
                >
                  영상 선택
                </button>
              )}
              <button
                className={`btn-secondary assignment-refresh${pending ? " is-loading" : ""}`}
                aria-label="새로고침"
                title="새로고침"
                aria-busy={pending}
                disabled={pending}
                onClick={() =>
                  void m.run({ version: 1, type: "PLAYBACK_REFRESH" })
                }
              >
                <Icon name="refresh" />
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

        {snapshot?.status === "blocked-autoplay" && (
          <Notice error>
            <p>
              Chrome이 자동 재생을 차단했습니다. 열려 있는 강의
              탭에서 영상 플레이어의 재생 버튼을 직접 누르세요. 접근 권한을
              다시 확인한 뒤 같은 영상부터 자동 재생을 이어갑니다.
            </p>
          </Notice>
        )}

        {snapshot?.status === "paused" && hasPlaylist && (
          <Notice>
            <p>강의 영상이 일시정지됐습니다.</p>
            {snapshot.nativeResumeAvailable && (
              <p>
                강의 탭에서 재생 버튼을 누르면 현재 위치와 선택한 목록을
                이어갑니다.
              </p>
            )}
            <button
              className="btn-primary"
              disabled={pending}
              onClick={() =>
                void m.run({ version: 1, type: "PLAYBACK_RESUME" })
              }
            >
              강의 탭에서 재개
            </button>
          </Notice>
        )}

        {resumable && snapshot?.status !== "blocked-login" && hasPlaylist && (
          <Notice
            error={snapshot?.status !== "stopped"}
          >
            <p>
              {snapshot?.status === "stopped"
                ? "자동 재생이 중지됐습니다. 다시 시작하려면 재개하세요."
                : "재생목록이 멈췄습니다. 강의 탭을 확인한 뒤 재개하세요."}
            </p>
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

        <section className="playback-playlist">
          <div className="playback-playlist-heading">
            <h3>재생목록</h3>
            <span>{playlist.length}개</span>
          </div>
          {hasPlaylist ? (
            <ol className="playback-queue" aria-label="재생목록">
              {playlist.map((item, index) => {
                const current = item.id === snapshot?.current?.id;
                const title = snapshot?.labels[item.id] ?? "영상 제목 확인 필요";
                return (
                  <li key={item.id}
                    className={current ? "playback-current" : undefined}
                    aria-current={current ? "true" : undefined}>
                    <span className="playback-position" aria-hidden="true">
                      {current ? <Icon name="playback" /> : index + 1}
                    </span>
                    <div>
                      <strong title={title}>{title}</strong>
                      <small>
                        {courseName(item.courseId)}
                        {current && snapshot && ` · ${status[snapshot.status] ?? "상태 확인"}`}
                      </small>
                    </div>
                  </li>
                );
              })}
            </ol>
          ) : (
            <p className="hint">재생목록이 비어 있습니다.</p>
          )}
        </section>

        <details className="guidance playback-guidance">
          <summary>안내 및 로컬 데이터</summary>
          <p className="hint">
            정상 속도(1배속)로 재생합니다. LMS가 탭 전환 시 영상을
            일시정지할 수 있습니다. 확장은 실제 재생 상태를 표시하며 강제로
            재생을 이어가지 않습니다.
          </p>
          <p className="hint">
            강의 플레이어에서 일시정지한 뒤 재생 버튼을 누르면 접근 권한을
            다시 확인하고 현재 위치와 선택한 목록을 이어갑니다. 자동 재생을
            끈 뒤에는 강의 플레이어의 재생만으로 다시 켜지지 않습니다. 영상
            종료와 LMS 이수 인정은 별개입니다.
          </p>
          <div className="settings-row">
            <div className="row-text">
              <p className="row-title">로컬 데이터</p>
              <p className="row-sub">
                {m.deletePrompt
                  ? "저장된 재생목록·상태와 미전송 사용 통계를 삭제합니다. 사용 통계 켜짐/꺼짐 선택은 유지됩니다."
                  : "이 기기에 저장된 재생목록과 설정을 삭제합니다."}
              </p>
            </div>
            <div className="row-actions">
              {m.deletePrompt ? (
                <>
                  <button
                    className="btn-secondary btn-danger"
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
                    className="btn-ghost"
                    onClick={() => m.setDeletePrompt(false)}
                  >
                    취소
                  </button>
                </>
              ) : (
                <button
                  className="btn-secondary btn-danger"
                  disabled={pending}
                  onClick={() => m.setDeletePrompt(true)}
                >
                  로컬 데이터 모두 삭제
                </button>
              )}
            </div>
          </div>
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
