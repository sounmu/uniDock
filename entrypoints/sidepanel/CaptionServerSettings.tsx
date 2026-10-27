import { useEffect, useState } from "react";
import {
  captionServerOrigin,
  signIn,
  signOut,
  signOutEverywhere,
} from "../../src/caption-server-settings";
import {
  getAccount,
  getSessionCount,
  getWorkerStatus,
  type CaptionAccount,
} from "../../src/captions/job-client";
import { useCaptionSession } from "./useCaptionSession";

const loginErrors: Record<string, string> = {
  LOGIN_CANCELLED: "로그인을 취소했습니다.",
  ACCOUNT_NOT_ALLOWED: "이 Google 계정으로는 AI 자막을 쓸 수 없습니다.",
  NO_SERVER: "자막 서버 주소가 설정되지 않았습니다.",
  NETWORK: "자막 서버에 연결하지 못했습니다.",
};

const code = (error: unknown) =>
  String((error as { code?: unknown } | null)?.code ?? "");

export function CaptionServerSettings() {
  const session = useCaptionSession();
  const [account, setAccount] = useState<CaptionAccount | null>(null);
  const [worker, setWorker] = useState<"online" | "offline" | null>(null);
  const [devices, setDevices] = useState<number | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const origin = captionServerOrigin();
  const signedIn = Boolean(session);

  useEffect(() => {
    if (!signedIn) {
      setAccount(null);
      setWorker(null);
      setDevices(null);
      return;
    }
    let live = true;
    void getAccount().then(
      (value) => live && setAccount(value),
      () => live && setAccount(null),
    );
    void getWorkerStatus().then(
      (value) => live && setWorker(value),
      () => live && setWorker(null),
    );
    void getSessionCount().then(
      (value) => live && setDevices(value),
      () => live && setDevices(null),
    );
    return () => {
      live = false;
    };
  }, [signedIn]);

  async function login() {
    setBusy(true);
    setNotice("");
    try {
      await signIn();
    } catch (error) {
      setNotice(loginErrors[code(error)] ?? "로그인에 실패했습니다. 다시 시도하세요.");
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    setBusy(true);
    await signOut();
    setBusy(false);
    setNotice("로그아웃했습니다.");
  }

  async function logoutEverywhere() {
    setBusy(true);
    try {
      await signOutEverywhere();
      setNotice("모든 기기에서 로그아웃했습니다.");
    } catch (error) {
      setNotice(
        (error as { code?: unknown }).code === "LOGIN_REQUIRED"
          ? "로그인이 만료되어 다른 기기는 로그아웃하지 못했습니다. 다시 로그인한 뒤 시도하세요."
          : "모든 기기 로그아웃에 실패했습니다. 잠시 후 다시 시도하세요.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="settings-group" aria-labelledby="caption-server-title">
      <h3 id="caption-server-title" className="settings-label" tabIndex={-1}>
        AI 자막 서버
      </h3>
      <div className="settings-card">
        <div className="settings-row">
          <div className="row-text">
            <p className="row-title">자막 서버</p>
            <p className="row-sub">{origin || "설정되지 않음"}</p>
          </div>
        </div>
        {session === null && (
          <div className="settings-row">
            <div className="row-text">
              <p className="row-title">계정</p>
              <p className="row-sub">AI 자막은 Google 계정으로 로그인해야 쓸 수 있습니다.</p>
            </div>
            <div className="row-actions">
              <button
                className="btn-secondary"
                disabled={busy}
                data-analytics-action="caption_server_login"
                onClick={() => void login()}
              >
                Google 계정으로 로그인
              </button>
            </div>
          </div>
        )}
        {session && (
          <>
            <div className="settings-row">
              <div className="row-text">
                <p className="row-title">계정</p>
                <p className="row-sub">{session.email}</p>
              </div>
              <div className="row-actions">
                <button
                  className="btn-ghost"
                  disabled={busy}
                  data-analytics-action="caption_server_logout"
                  onClick={() => void logout()}
                >
                  로그아웃
                </button>
                <button
                  className="btn-ghost"
                  disabled={busy}
                  data-analytics-action="caption_server_logout_all"
                  onClick={() => void logoutEverywhere()}
                >
                  모든 기기에서 로그아웃
                </button>
              </div>
            </div>
            <div className="settings-row">
              <div className="row-text">
                <p className="row-title">이번 주 사용</p>
                <p className="row-sub">
                  {account
                    ? `${account.quota.used} / ${account.quota.limit}회 · ${new Date(
                        account.quota.resetsAt,
                      ).toLocaleString()}에 초기화`
                    : "확인하지 못했습니다."}
                </p>
              </div>
            </div>
            <div className="settings-row">
              <div className="row-text">
                <p className="row-title">로그인된 기기</p>
                <p className="row-sub">
                  {devices === null ? "확인하지 못했습니다." : `${devices}대 (최대 10대)`}
                </p>
              </div>
            </div>
            <div className="settings-row">
              <div className="row-text">
                <p className="row-title">처리 서버</p>
                <p className="row-sub">
                  {worker === "online"
                    ? "켜져 있음"
                    : worker === "offline"
                      ? "꺼져 있음 (요청은 대기열에 남습니다)"
                      : "확인하지 못했습니다."}
                </p>
              </div>
            </div>
          </>
        )}
        {notice && (
          <p className="settings-row row-sub" role="status">
            {notice}
          </p>
        )}
      </div>
    </section>
  );
}
