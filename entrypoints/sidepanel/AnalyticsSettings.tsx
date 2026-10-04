import { useState } from "react";
import type { AnalyticsStatus } from "../../src/analytics/contract";
import { setAnalyticsConsent } from "./analytics";
export function AnalyticsSettings({
  status,
}: {
  readonly status: AnalyticsStatus;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  async function change(enabled: boolean) {
    setPending(true);
    setError(false);
    const ok = await setAnalyticsConsent(enabled);
    setError(!ok);
    setPending(false);
  }
  return (
    <section
      className="settings-group"
      aria-labelledby="analytics-title"
      aria-busy={pending}
    >
      <h3 id="analytics-title" className="settings-label">
        사용 통계
      </h3>
      <div className="settings-card">
        <div className="settings-row">
          <div className="row-text">
            <p className="row-title">사용 통계 공유 (선택)</p>
            <p className="row-sub" role="status">
              {!status.available
                ? "이 빌드는 분석 서비스가 연결되지 않아 통계를 전송하지 않습니다."
                : status.choice === "enabled"
                  ? "사용 통계 공유 중"
                  : "사용 통계 공유 안 함"}
            </p>
          </div>
          <div className="row-actions">
            {status.choice !== "enabled" && (
              <button
                className="btn-secondary"
                disabled={pending || !status.available}
                onClick={() => void change(true)}
              >
                동의하고 통계 공유
              </button>
            )}
            {status.choice !== "disabled" && (
              <button
                className="btn-ghost"
                disabled={pending}
                onClick={() => void change(false)}
              >
                {status.choice === "enabled"
                  ? "통계 공유 철회"
                  : "공유하지 않음"}
              </button>
            )}
          </div>
        </div>
        {error && (
          <p className="settings-row row-error" role="alert">
            설정을 저장하지 못했습니다. 다시 시도해 주세요.
          </p>
        )}
        <details className="settings-row settings-more">
          <summary>보내는 정보와 보관</summary>
          <p>
            기능 개선을 위해 화면 이동, 버튼 사용, 기능 성공·실패와 패널
            표시·활성 시간을 PostHog(EU)에 전송합니다. 동의한 설치의 이용 빈도와
            재방문을 분석합니다.
          </p>
          <p>
            동의하면 무작위 설치 식별자를 저장합니다. LMS
            정보·계정·과목명·URL·입력값·자막·파일 내용은 보내지 않습니다. IP
            주소는 통신 과정에서 수신 서버에 전달되며 IP 저장·위치 분석을
            제한합니다.
          </p>
          <p>
            동의하지 않아도 모든 학습 기능을 이용할 수 있습니다. 정보 화면에서
            언제든 철회할 수 있고, 철회하면 이 기기의 식별자를 삭제합니다. 이미
            전송된 통계는 소급 삭제되지 않습니다.
          </p>
          <a
            href="privacy.html"
            target="_blank"
            rel="noreferrer"
            data-analytics-action="privacy_open"
          >
            보관·삭제 및 개인정보 처리방침
          </a>
        </details>
        {status.consentId && (
          <details className="settings-row settings-more">
            <summary>통계 삭제 요청용 식별자</summary>
            <p>
              원격 통계 삭제는 철회 전에 아래 값을 복사해 스토어 지원 연락처로
              요청하세요. 이벤트는 최대 90일 보관합니다.
            </p>
            <p>
              <code>{status.consentId}</code>
            </p>
          </details>
        )}
      </div>
    </section>
  );
}
