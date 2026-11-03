import { useState } from "react";
import type { AnalyticsStatus } from "../../src/analytics/contract";
import { setAnalyticsEnabled } from "./analytics";

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
    setError(!(await setAnalyticsEnabled(enabled)));
    setPending(false);
  }
  const busy = pending || !status.available;
  return (
    <section
      className="settings-group"
      aria-labelledby="analytics-title"
      aria-busy={pending}
    >
      <h3 id="analytics-title" className="settings-label" tabIndex={-1}>
        사용 통계
      </h3>
      <div className="settings-card">
        <div className="settings-row">
          <div className="row-text">
            <p id="analytics-row-title" className="row-title">
              사용 통계 보내기
            </p>
            <p id="analytics-description" className="row-sub" role="status">
              {!status.available
                ? "이 빌드는 통계를 보내지 않습니다."
                : status.enabled
                  ? "켜짐 · 기능별 하루 합계만 보냅니다."
                  : "꺼짐 · 수집하거나 보내지 않습니다."}
            </p>
          </div>
          <button
            type="button"
            role="switch"
            className="switch"
            aria-checked={status.available && status.enabled}
            aria-disabled={busy}
            aria-labelledby="analytics-row-title"
            aria-describedby="analytics-description"
            onClick={() => {
              if (!busy) void change(!status.enabled);
            }}
          >
            <span className="switch-track" aria-hidden="true">
              <span className="switch-knob">
                {status.available && status.enabled && (
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
            설정을 저장하지 못했습니다. 다시 시도해 주세요.
          </p>
        )}
        <details className="settings-row settings-more">
          <summary>보내는 정보</summary>
          <p>
            어떤 기능이 쓰이고, 성공하는지, 느린지 알기 위해 이 기기에서 하루
            단위로 센 숫자만 보냅니다: 사용한 날 여부, 서비스별 진입 수, 자료
            다운로드·자막 저장 같은 결과 수, 작업별 시작·성공·실패·시간
            초과·취소 수, 정해진 오류 코드, 처리 시간 구간, 확장 버전.
          </p>
          <p>
            학번·이름·계정, 과목·강의·과제 이름, LMS 주소, 입력 내용, 자막, 파일
            내용과 설치 식별자는 보내지 않습니다.
          </p>
          <p>
            개발자의 수집 서버가 전체 합계로 합친 뒤 Google Analytics 4로
            보냅니다. 서버는 통신 중 IP 주소를 받지만 통계에 저장하거나 Google에
            넘기지 않습니다.
          </p>
          <p>
            끄면 바로 수집·전송을 멈추고 이 기기의 미전송 통계를 지웁니다. 이미
            전체 합계에 더해진 숫자는 설치별로 구분되지 않아 지울 수 없습니다.
          </p>
          <a href="privacy.html" target="_blank" rel="noreferrer">
            개인정보 처리방침
          </a>
        </details>
      </div>
    </section>
  );
}
