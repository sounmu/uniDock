import { AnalyticsSettings } from "../AnalyticsSettings";
import { CaptionServerSettings } from "../CaptionServerSettings";
import { LocalDataSettings } from "../LocalDataSettings";
import { PopupSettings } from "../PopupSettings";
import type { useAnalytics } from "../useAnalytics";
import { DetailView } from "../ui/DetailView";
import { Icon } from "../ui/icons";

export function SettingsScreen({
  analytics, version, onBack,
}: {
  readonly analytics: ReturnType<typeof useAnalytics>;
  readonly version: string;
  readonly onBack: () => void;
}) {
  return (
    <DetailView title="설정" backLabel="돌아가기" onBack={onBack}>
      <PopupSettings />
      {__UNIDOCK_AI_CAPTIONS__ && <CaptionServerSettings />}
      <section className="settings-group" aria-labelledby="privacy-title">
        <h3 id="privacy-title" className="settings-label">개인정보·데이터</h3>
        <div className="settings-card">
          <div className="settings-row">
            <div className="row-text">
              <p className="row-title">LMS 정보는 이 기기에서만 표시</p>
              <p className="row-sub">
                조회 시 현재 LMS 세션의 정보를 이 기기에 표시하며 분석 서비스로 전송하지 않습니다.{" "}
                {__UNIDOCK_PLAYBACK__
                  ? "통계 공유·팝업 자동 닫기·재생 설정은 이 기기에 저장합니다."
                  : "조회 결과는 메모리에만 잠시 유지하고, 다운로드한 자막·자료, 통계 공유와 팝업 자동 닫기 설정은 기기에 저장됩니다."}
              </p>
            </div>
          </div>
          <a className="settings-row settings-link" href="privacy.html" target="_blank" rel="noreferrer">
            <span className="row-title">개인정보 처리방침</span><Icon name="external" />
          </a>
        </div>
        <AnalyticsSettings status={analytics} />
        <LocalDataSettings />
      </section>
      <section className="settings-group" aria-labelledby="about-title">
        <h3 id="about-title" className="settings-label">uniDock 정보</h3>
        <div className="about-app">
          <img src="icons/48.png" alt="" width={40} height={40} />
          <div>
            <p className="about-name">uniDock</p>
            <p className="about-meta">{version ? `버전 ${version} · ` : ""}고려대학교와 제휴하지 않은 비공식 도구</p>
          </div>
        </div>
        <div className="settings-card">
          <a className="settings-row settings-link" href="https://mylms.korea.ac.kr/"
            target="_blank" rel="noreferrer" aria-label="LMS 열기 (새 탭)" data-analytics-action="lms_open">
            <span className="row-title">LMS 열기</span><Icon name="external" />
          </a>
          <a className="settings-row settings-link" href="updates.html" target="_blank" rel="noreferrer">
            <span className="row-title">현재 버전 변경 사항</span><Icon name="external" />
          </a>
          <a className="settings-row settings-link" href="privacy.html" target="_blank" rel="noreferrer">
            <span className="row-title">개인정보 처리방침</span><Icon name="external" />
          </a>
        </div>
      </section>
    </DetailView>
  );
}
