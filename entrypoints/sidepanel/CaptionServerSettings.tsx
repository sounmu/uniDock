import { useEffect, useState } from "react";
import {
  captionServerOrigin,
  captionServerToken,
  clearCaptionServerToken,
  saveCaptionServerToken,
} from "../../src/caption-server-settings";
import { getJob, JobError } from "../../src/captions/job-client";

export function CaptionServerSettings() {
  const [token, setToken] = useState("");
  const [saved, setSaved] = useState(false);
  const [notice, setNotice] = useState("");
  const origin = captionServerOrigin();

  useEffect(() => {
    void captionServerToken().then((value) => setSaved(value !== null));
  }, []);

  async function save() {
    try {
      await saveCaptionServerToken(token);
      setToken("");
      setSaved(true);
      setNotice("토큰을 저장했습니다.");
    } catch {
      setNotice("토큰 형식이 올바르지 않습니다.");
    }
  }

  async function clear() {
    await clearCaptionServerToken();
    setSaved(false);
    setNotice("토큰을 삭제했습니다.");
  }

  async function test() {
    try {
      await getJob("healthcheck-unidock");
      setNotice("서버에 연결했습니다.");
    } catch (error) {
      if (error instanceof JobError)
        setNotice(
          error.code === "NETWORK" || error.code === "NO_SERVER"
            ? "서버에 연결하지 못했습니다."
            : error.code === "NO_TOKEN"
              ? "토큰을 먼저 저장하세요."
              : error.code === "AUTH"
                ? "서버가 토큰을 거부했습니다. 토큰을 다시 확인하세요."
                : error.code === "EXPIRED"
                  ? "서버에 연결했고 토큰이 받아들여졌습니다."
                  : "서버가 오류를 돌려주었습니다. 잠시 후 다시 시도하세요.",
        );
      else setNotice("서버에 연결하지 못했습니다.");
    }
  }

  return (
    <section className="settings-group" aria-labelledby="caption-server-title">
      <h3 id="caption-server-title" className="settings-label">
        AI 자막 서버
      </h3>
      <div className="settings-card">
        <div className="settings-row">
          <div className="row-text">
            <p className="row-title">자막 서버</p>
            <p className="row-sub">{origin || "설정되지 않음"}</p>
          </div>
        </div>
        <div className="settings-row">
          <div className="row-text">
            <label className="row-title" htmlFor="caption-server-token">
              서버 토큰
            </label>
            <input
              id="caption-server-token"
              type="password"
              className="input"
              value={token}
              placeholder={saved ? "저장됨 (다시 입력해 교체)" : "토큰 입력"}
              onChange={(event) => setToken(event.target.value)}
            />
          </div>
          <div className="row-actions">
            <button
              className="btn-secondary"
              disabled={!token.trim()}
              data-analytics-action="caption_server_save"
              onClick={() => void save()}
            >
              저장
            </button>
            {saved && (
              <button
                className="btn-ghost"
                data-analytics-action="caption_server_clear"
                onClick={() => void clear()}
              >
                삭제
              </button>
            )}
            <button
              className="btn-ghost"
              data-analytics-action="caption_server_test"
              onClick={() => void test()}
            >
              연결 확인
            </button>
          </div>
        </div>
        {notice && (
          <p className="settings-row row-sub" role="status">
            {notice}
          </p>
        )}
      </div>
    </section>
  );
}
