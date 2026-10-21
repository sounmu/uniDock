import { useEffect, useState } from "react";
import {
  popupAutoCloseKey,
  watchPopupAutoClose,
} from "../../src/popup-settings";

export function PopupSettings() {
  const [enabled, setEnabled] = useState(false);
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    return watchPopupAutoClose(
      (value) => {
        setEnabled(value);
        setReady(true);
        setError(false);
      },
      () => setError(true),
    );
  }, []);
  async function change(value: boolean) {
    setPending(true);
    setError(false);
    try {
      await chrome.storage.local.set({ [popupAutoCloseKey]: value });
    } catch {
      setError(true);
    } finally {
      setPending(false);
    }
  }
  return (
    <section
      className="settings-group"
      aria-labelledby="popup-title"
      aria-busy={pending}
    >
      <h3 id="popup-title" className="settings-label">
        LMS 공지
      </h3>
      <div className="settings-card">
        <div className="settings-row">
          <div className="row-text">
            <p id="popup-row-title" className="row-title">
              공지 자동 닫기
            </p>
            <p id="popup-description" className="row-sub">
              LMS의 공지 팝업을 자동으로 닫습니다. ‘오늘 하루 보지 않기’는
              선택하지 않습니다. 설정을 끄면 다음에 나타나는 공지를 그대로
              표시합니다.
            </p>
          </div>
          <div className="row-actions">
            <select
              aria-labelledby="popup-row-title"
              aria-describedby="popup-description"
              value={enabled ? "on" : "off"}
              disabled={!ready || pending}
              onChange={(event) => void change(event.target.value === "on")}
            >
              <option value="off">꺼짐</option>
              <option value="on">켜짐</option>
            </select>
          </div>
        </div>
        {error && (
          <p className="settings-row row-error" role="alert">
            설정을 읽거나 저장하지 못했습니다. 정보 화면을 다시 열어주세요.
          </p>
        )}
      </div>
    </section>
  );
}
