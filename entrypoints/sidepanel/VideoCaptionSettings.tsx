import { useEffect, useState } from "react";
import { saveVideoCaptions, watchVideoCaptions } from "../../src/video-captions";

export function VideoCaptionSettings() {
  const [enabled, setEnabled] = useState(true);
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  useEffect(
    () =>
      watchVideoCaptions(
        (value) => {
          setEnabled(value);
          setReady(true);
          setError(false);
        },
        () => setError(true),
      ),
    [],
  );
  function change(value: boolean) {
    setError(false);
    setPending(true);
    saveVideoCaptions(value)
      .catch(() => setError(true))
      .finally(() => setPending(false));
  }
  const busy = !ready || pending;
  return (
    <section
      className="settings-group"
      aria-labelledby="video-captions-title"
      aria-busy={pending}
    >
      <h3 id="video-captions-title" className="settings-label">
        자막
      </h3>
      <div className="settings-card">
        <div className="settings-row">
          <div className="row-text">
            <p id="video-captions-row-title" className="row-title">
              강의 영상에 자막 표시
            </p>
            <p id="video-captions-description" className="row-sub">
              감지한 공식 자막이나 AI 자막을 강의 영상 위에 띄웁니다. 전체 화면에서도 보입니다.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            className="switch"
            aria-checked={enabled}
            aria-disabled={busy}
            aria-labelledby="video-captions-row-title"
            aria-describedby="video-captions-description"
            onClick={() => {
              if (!busy) change(!enabled);
            }}
          >
            <span className="switch-track" aria-hidden="true">
              <span className="switch-knob">
                {enabled && (
                  <svg
                    className="switch-check"
                    viewBox="0 0 12 12"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="m2.5 6.5 2.3 2.3 4.7-5" />
                  </svg>
                )}
              </span>
            </span>
          </button>
        </div>
        {error && (
          <p className="settings-row row-error" role="alert">
            설정을 읽거나 저장하지 못했습니다. 설정 화면을 다시 여세요.
          </p>
        )}
      </div>
    </section>
  );
}
