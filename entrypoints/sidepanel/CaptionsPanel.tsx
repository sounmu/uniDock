import { useEffect, useRef, useState } from "react";
import {
  detectCaptions,
  type CaptionTarget,
  type CaptionResult,
} from "../../src/captions/service";
import { downloadCaption } from "../../src/captions/download";
import { ScreenHeader } from "./ui/ScreenHeader";
import { ListRow } from "./ui/ListRow";
import { StatusChip } from "./ui/StatusChip";
import { DetailView, useDetail } from "./ui/DetailView";
import { Notice } from "./ui/Notice";
import { featureResult } from "./analytics";
const messages = {
  ACTIVATE_TAB:
    "강의 플레이어 탭을 선택하고 도구 모음의 uniDock 아이콘을 누른 뒤 다시 감지하세요.",
  NO_CAPTIONS:
    "화면 자막이나 플레이어 자막 파일을 찾지 못했습니다. 강의 플레이어가 열린 상태인지 확인하세요.",
  UNSAFE_CAPTION:
    "접근이 제한되었거나 안전하게 저장할 수 있는 자막이 없습니다. 플레이어를 별도 탭으로 열어 다시 확인하세요.",
  TIMEOUT: "자막 감지 시간이 초과되었습니다. 잠시 후 다시 시도하세요.",
  RELOAD_TAB: "강의 문서가 변경되었습니다. 현재 강의에서 다시 감지하세요.",
};
export function CaptionsPanel() {
  const [state, setState] = useState<
    CaptionResult | { status: "idle" | "loading" }
  >({
    status: "idle",
  });
  const [notice, setNotice] = useState("");
  const [exportPending, setExportPending] = useState(false);
  const { detail, open, back } = useDetail<number>();
  const selected =
    state.status === "success" && detail !== null
      ? state.captions[detail]
      : undefined;
  const generation = useRef(0);
  const target = useRef<CaptionTarget | null>(null);
  const detection = useRef<AbortController | null>(null);
  const exportController = useRef<AbortController | null>(null);
  const exportLocked = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    const clear = () => {
      generation.current++;
      detection.current?.abort();
      detection.current = null;
      exportController.current?.abort();
      exportController.current = null;
      exportLocked.current = false;
      target.current = null;
      setState({ status: "idle" });
      setExportPending(false);
      setNotice("");
    };
    const activated = (info: { tabId: number; windowId: number }) => {
      if (
        !target.current ||
        (info.windowId === target.current.windowId &&
          info.tabId !== target.current.tabId)
      )
        clear();
    };
    const updated = (
      tabId: number,
      change: { status?: string; url?: string },
    ) => {
      if (
        tabId === target.current?.tabId &&
        (change.status === "loading" || change.url !== undefined)
      )
        clear();
    };
    const removed = (tabId: number) => {
      if (tabId === target.current?.tabId) clear();
    };
    chrome.tabs.onActivated.addListener(activated);
    chrome.tabs.onUpdated.addListener(updated);
    chrome.tabs.onRemoved.addListener(removed);
    return () => {
      mounted.current = false;
      generation.current++;
      detection.current?.abort();
      detection.current = null;
      exportController.current?.abort();
      exportController.current = null;
      exportLocked.current = false;
      target.current = null;
      chrome.tabs.onActivated.removeListener(activated);
      chrome.tabs.onUpdated.removeListener(updated);
      chrome.tabs.onRemoved.removeListener(removed);
    };
  }, []);
  useEffect(() => {
    if (state.status !== "success") return;
    const timer = setTimeout(() => {
      generation.current++;
      exportController.current?.abort();
      exportController.current = null;
      exportLocked.current = false;
      setState({ status: "idle" });
      setExportPending(false);
      setNotice("자막 보관 시간이 만료되었습니다. 다시 감지하세요.");
    }, 300000);
    return () => clearTimeout(timer);
  }, [state]);
  async function detect() {
    const report = featureResult("captions_detect");
    back();
    detection.current?.abort();
    exportController.current?.abort();
    exportController.current = null;
    exportLocked.current = false;
    setExportPending(false);
    const controller = new AbortController();
    detection.current = controller;
    const current = ++generation.current;
    setState({ status: "loading" });
    setNotice("");
    const isCurrent = () =>
      mounted.current &&
      current === generation.current &&
      detection.current === controller;
    const result = await detectCaptions(
      (selected) => {
        if (!isCurrent()) return false;
        target.current = selected;
        return true;
      },
      controller.signal,
      isCurrent,
    );
    if (isCurrent()) {
      detection.current = null;
      report(result.status === "success");
      setState(result);
    }
  }
  async function download() {
    if (!selected || exportLocked.current) return;
    const report = featureResult("captions_export");
    exportLocked.current = true;
    const controller = new AbortController();
    exportController.current = controller;
    const current = generation.current;
    setExportPending(true);
    const isCurrent = () =>
      mounted.current &&
      current === generation.current &&
      exportController.current === controller;
    try {
      const result = await downloadCaption(selected, {
        signal: controller.signal,
        isCurrent,
      });
      if (!isCurrent()) return;
      report(result.status === "complete");
      if (result.status === "complete") {
        setNotice(
          "output/에 TXT·JSON 다운로드를 요청했습니다. 브라우저 다운로드 목록을 확인하세요.",
        );
      } else if (result.accepted === 1) {
        setNotice(
          "TXT 다운로드만 요청되었습니다. JSON은 요청되지 않았습니다. 브라우저 다운로드 목록을 확인하세요.",
        );
      } else {
        setNotice("다운로드를 요청하지 못했습니다. 다시 시도하세요.");
      }
    } catch {
      if (isCurrent()) report(false);
      if (isCurrent())
        setNotice(
          "다운로드 요청을 완료하지 못했습니다. 일부 파일만 저장되었을 수 있으니 다운로드 목록을 확인하세요.",
        );
    } finally {
      if (isCurrent()) {
        exportController.current = null;
        exportLocked.current = false;
        setExportPending(false);
      }
    }
  }
  return (
    <section>
      <div hidden={selected !== undefined}>
        <ScreenHeader
          title="자막 추출"
          action={
            <button
              className="btn-primary"
              disabled={state.status === "loading"}
              onClick={() => void detect()}
              data-analytics-action="captions_detect"
            >
              {state.status === "loading" ? "감지 중…" : "자막 감지"}
            </button>
          }
        />
        <details className="guidance">
          <summary data-analytics-action="guidance">안내</summary>
          <p className="hint">
            강의 탭에서 uniDock 아이콘을 눌러 임시 접근을 허용하세요. 감지를
            누르면 화면의 자막 목록을 먼저 읽고, 없으면 KU 플레이어의 XML·VTT
            자막 파일을 조회하고, 별도 TXT 스크립트도 확인합니다. 다운로드를
            누르면 시간과 문장을 다운로드 폴더의 output/ 아래 TXT·JSON 두 파일로
            저장합니다. JSON에는 강의 URL과 제목도 포함됩니다. 개발자 서버로
            전송하지 않습니다. 영상 재생은 직접 조작하세요.
          </p>
        </details>
        <div aria-live="polite" aria-busy={state.status === "loading"}>
          {state.status === "error" && (
            <Notice error>{messages[state.code]}</Notice>
          )}
          {state.status === "success" && (
            <>
              <p className="count">
                자막 {state.captions.length}개 · 5분 동안 메모리에 보관
              </p>
              {state.blocked && (
                <p className="hint">
                  일부 자막 또는 프레임은 접근·검증 제한으로 제외되었습니다.
                </p>
              )}
              <ul>
                {state.captions.map((caption, index) => (
                  <li key={index}>
                    <ListRow
                      title={caption.label}
                      course={caption.pageTitle}
                      chip={
                        <StatusChip>
                          {caption.source === "caption_script_dom"
                            ? "확인 필요"
                            : caption.source === "player_media_script"
                              ? "스크립트"
                              : "공식 자막"}
                        </StatusChip>
                      }
                      onClick={() => open(index)}
                    />
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>
      {selected && (
        <DetailView
          title={selected.label}
          onBack={back}
          meta={[
            ["문장 수", `${selected.itemCount.toLocaleString()}개 문장`],
            [
              "출처 설명",
              selected.source === "caption_script_dom"
                ? "현재 로드된 스크립트 (전체 여부 확인 필요)"
                : selected.source === "player_media_script"
                  ? "원본 스크립트 · 표기 시각은 영상 재생 위치와 다를 수 있음"
                  : "공식 자막 트랙",
            ],
          ]}
        >
          <button
            className="btn-primary"
            disabled={exportPending}
            onClick={() => void download()}
            data-analytics-action="captions_export"
          >
            TXT·JSON 다운로드
          </button>
        </DetailView>
      )}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
    </section>
  );
}
