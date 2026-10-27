import { useEffect, useState } from "react";
import {
  POPUP_PERMISSION,
  popupAutoCloseKey,
  runPopupChange,
  watchPopupAutoClose,
  watchPopupChangeBusy,
} from "../../src/popup-settings";

export function PopupSettings() {
  const [enabled, setEnabled] = useState(false);
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<"storage" | "denied" | null>(null);
  useEffect(() => {
    return watchPopupAutoClose(
      (value) => {
        setEnabled(value);
        setReady(true);
        setError(null);
      },
      () => setError("storage"),
    );
  }, []);
  // Shared with local-data deletion: one grant/opt-in change at a time.
  useEffect(() => watchPopupChangeBusy(setPending), []);
  function change(value: boolean) {
    setError(null);
    // The grant request starts inside the click (Chrome prompts only for a
    // user gesture) and before ON is saved; OFF is saved before the grant is
    // returned. The switch stays busy until both steps finish, so a quick
    // OFF -> ON can never request against a grant that is about to go away.
    void runPopupChange(async () => {
      if (value) {
        if (!(await chrome.permissions.request(POPUP_PERMISSION))) {
          setError("denied");
          return;
        }
        await chrome.storage.local.set({ [popupAutoCloseKey]: true });
        return;
      }
      await chrome.storage.local.set({ [popupAutoCloseKey]: false });
      await chrome.permissions.remove(POPUP_PERMISSION);
    }).catch(() => setError("storage"));
  }
  const busy = !ready || pending;
  return (
    <section
      className="settings-group"
      aria-labelledby="popup-title"
      aria-busy={pending}
    >
      <h3 id="popup-title" className="settings-label">
        LMS 팝업
      </h3>
      <div className="settings-card">
        <div className="settings-row">
          <div className="row-text">
            <p id="popup-row-title" className="row-title">
              팝업 자동 닫기
            </p>
            <p id="popup-description" className="row-sub">
              LMS의 공지 팝업과 미참여 설문 안내를 자동으로 닫습니다. ‘오늘 하루
              보지 않기’는 선택하지 않고, 설문에는 참여하지 않으며 ‘설문
              나가기’만 누릅니다. 켤 때 Chrome이 lms.korea.ac.kr 접근 허용을
              묻고, 끄면 그 권한을 반납합니다.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            className="switch"
            aria-checked={enabled}
            aria-disabled={busy}
            aria-labelledby="popup-row-title"
            aria-describedby="popup-description"
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
            {error === "denied"
              ? "lms.korea.ac.kr 접근을 허용해야 켤 수 있습니다."
              : "설정을 읽거나 저장하지 못했습니다. 설정 화면을 다시 여세요."}
          </p>
        )}
      </div>
    </section>
  );
}
