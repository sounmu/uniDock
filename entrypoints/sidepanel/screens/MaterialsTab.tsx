import { useEffect, useRef, useState } from "react";
import type { Document } from "../../../src/documents";
import { copyPromptAndOpen } from "../../../src/pdf/handoff";
import { PagedList } from "../PagedList";
import { downloadLabels } from "../useDocumentDownloads";
import { messages } from "../query-messages";
import { DetailView, useDetail } from "../ui/DetailView";
import { ScreenHeader } from "../ui/ScreenHeader";
import { ListRow } from "../ui/ListRow";
import { StatusChip } from "../ui/StatusChip";
import { Notice } from "../ui/Notice";
import type { PanelModel } from "./QueryResults";
import { featureResult } from "../analytics";
export function MaterialsTab({ model }: { readonly model: PanelModel }) {
  const { state, course, downloads, recordingAction } = model;
  const items =
    state.status === "success" && "documents" in state ? state.documents : [];
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const [notice, setNotice] = useState("");
  const handoffInFlight = useRef(false);
  const handoffGeneration = useRef(0);
  const [handoffPending, setHandoffPending] = useState(false);
  const { detail, open, back } = useDetail<Document>();
  useEffect(() => {
    handoffInFlight.current = false;
    setHandoffPending(false);
    setNotice("");
    return () => {
      handoffGeneration.current++;
      handoffInFlight.current = false;
    };
  }, [course, model.selectedCourse?.courseSelector]);
  const available = items.filter(
    (item) =>
      item.downloadHandle &&
      (!downloads.statuses[item.downloadHandle] ||
        downloads.statuses[item.downloadHandle] === "cancelled"),
  );
  const selected = available.filter((item) =>
    selection.has(item.downloadHandle),
  );
  const label = (item: Document) => {
    const status = downloads.statuses[item.downloadHandle];
    return !item.downloadHandle
      ? "LMS에서 확인"
      : status
        ? downloadLabels[status]
        : "대기";
  };
  const download = (values: readonly Document[]) =>
    void downloads.downloadDocuments(
      items,
      values.map((item) => item.downloadHandle),
    );
  return (
    <>
      <div hidden={detail !== null}>
        <ScreenHeader
          title={`수업 자료 · ${items.length}개 PDF`}
          action={
            downloads.progress.running ? (
              <button
                className="btn-secondary"
                onClick={downloads.cancel}
                data-analytics-action="download_cancel"
              >
                취소
              </button>
            ) : (
              <button
                className="btn-primary"
                disabled={!available.length || recordingAction.pending}
                onClick={() => download(selected.length ? selected : available)}
                data-analytics-action="download_batch"
              >
                {selected.length
                  ? `선택 다운로드 (${selected.length})`
                  : "PDF 전체 다운로드"}
              </button>
            )
          }
        />
        <button
          className="btn-ghost"
          disabled={downloads.progress.running || state.status === "loading"}
          onClick={() => void model.load(model.query, { refresh: true })}
          data-analytics-action="refresh"
        >
          목록 새로고침
        </button>
        <details className="guidance">
          <summary data-analytics-action="guidance">안내</summary>
          <p className="hint">
            모듈에 공개된 PDF만 표시합니다. 선택한 자료는 브라우저 다운로드
            폴더에 저장합니다. 확장은 PDF 내용을 읽거나 업로드하지 않습니다.
          </p>
        </details>
        {state.status === "loading" && (
          <Notice>목록을 불러오고 있습니다…</Notice>
        )}
        {state.status === "error" && (
          <Notice error>{messages[state.code]}</Notice>
        )}
        {state.status === "success" && !items.length && (
          <Notice>모듈에서 확인 가능한 PDF가 없습니다.</Notice>
        )}
        {items.length > 0 && (
          <>
            <label className="remaining-toggle">
              <input
                type="checkbox"
                data-analytics-action="select_all"
                disabled={!available.length || downloads.progress.running}
                checked={
                  available.length > 0 && selected.length === available.length
                }
                onChange={(e) =>
                  setSelection(
                    e.target.checked
                      ? new Set(available.map((item) => item.downloadHandle))
                      : new Set(),
                  )
                }
              />
              전체 선택
            </label>
            <PagedList items={items}>
              {(item, index) => (
                <li key={item.lmsHandle} className="material-item">
                  {(index % 100 === 0 ||
                    items[index - 1]?.module !== item.module) && (
                    <h3 className="module-heading">
                      {item.module || "모듈 이름 없음"}
                    </h3>
                  )}
                  <div className="selectable-row">
                    <input
                      type="checkbox"
                      data-analytics-action="select_item"
                      aria-label={`${item.title} 선택`}
                      disabled={
                        !available.includes(item) || downloads.progress.running
                      }
                      checked={selection.has(item.downloadHandle)}
                      onChange={(e) =>
                        setSelection((previous) => {
                          const next = new Set(previous);
                          if (e.target.checked) next.add(item.downloadHandle);
                          else next.delete(item.downloadHandle);
                          return next;
                        })
                      }
                    />
                    <ListRow
                      title={item.title}
                      course={course}
                      chip={<StatusChip>{label(item)}</StatusChip>}
                      onClick={() => open(item)}
                    />
                  </div>
                </li>
              )}
            </PagedList>
          </>
        )}
      </div>
      {detail && (
        <DetailView
          title={detail.title}
          onBack={back}
          meta={[
            ["모듈", detail.module],
            ["파일명", detail.title],
            ["상태", label(detail)],
          ]}
        >
          <div className="tools">
            {detail.downloadHandle && (
              <button
                className={
                  downloads.progress.running ? "btn-secondary" : "btn-primary"
                }
                disabled={
                  !downloads.progress.running &&
                  (!available.includes(detail) || recordingAction.pending)
                }
                data-analytics-action={
                  downloads.progress.running
                    ? "download_cancel"
                    : "download_one"
                }
                onClick={() =>
                  downloads.progress.running
                    ? downloads.cancel()
                    : download([detail])
                }
              >
                {downloads.progress.running ? "취소" : "이 PDF 다운로드"}
              </button>
            )}
            <button
              className="btn-secondary"
              disabled={
                recordingAction.pending ||
                downloads.progress.running ||
                recordingAction.used.has(detail.lmsHandle)
              }
              onClick={() => void model.openDocument(detail.lmsHandle)}
              data-analytics-action="document_open"
            >
              LMS에서 열기 ↗
            </button>
          </div>
        </DetailView>
      )}
      {downloads.progress.total > 0 && (
        <>
          <div role="status" className="download-progress">
            <progress
              aria-label="PDF 다운로드 진행률"
              max={downloads.progress.total}
              value={downloads.progress.done}
            />
            <span>
              {downloads.progress.done}/{downloads.progress.total}
            </span>
          </div>
          {!downloads.progress.running && (
            <>
              <div className="tools">
                <button
                  className="btn-secondary"
                  onClick={() => {
                    chrome.downloads.showDefaultFolder();
                  }}
                  data-analytics-action="download_folder"
                >
                  다운로드 폴더 열기
                </button>
                <button
                  className="btn-secondary"
                  disabled={handoffPending}
                  data-analytics-action="ai_handoff"
                  onClick={() => {
                    if (handoffInFlight.current) return;
                    const report = featureResult("ai_handoff");
                    handoffInFlight.current = true;
                    const current = ++handoffGeneration.current;
                    const isCurrent = () =>
                      current === handoffGeneration.current;
                    setHandoffPending(true);
                    void copyPromptAndOpen(course, isCurrent)
                      .then(
                        (copied) => {
                          if (!isCurrent()) return;
                          report(copied);
                          setNotice(
                            copied
                              ? "질문을 복사했습니다. PDF를 직접 첨부하고 붙여넣으세요."
                              : "질문을 복사하지 못했습니다. ChatGPT 창에서 직접 질문하고 PDF를 첨부하세요.",
                          );
                        },
                        () => {
                          if (!isCurrent()) return;
                          report(false);
                          setNotice(
                            "ChatGPT 탭을 열지 못했습니다. 직접 chatgpt.com을 열어주세요.",
                          );
                        },
                      )
                      .finally(() => {
                        if (!isCurrent()) return;
                        handoffInFlight.current = false;
                        setHandoffPending(false);
                      });
                  }}
                >
                  ChatGPT에서 질문하기 ↗
                </button>
              </div>
              <p className="hint">
                다운로드/uniDock/{course}/의 PDF를 ChatGPT 창에 끌어다
                첨부하세요. uniDock은 파일을 업로드하지 않습니다.
              </p>
            </>
          )}
        </>
      )}
      {downloads.notice && <Notice>{downloads.notice}</Notice>}
      {recordingAction.notice && <Notice>{recordingAction.notice}</Notice>}
      {notice && <Notice>{notice}</Notice>}
      {Object.values(downloads.statuses).includes("review") && (
        <Notice>
          PDF 형식인지 확인이 필요합니다. 로그인 페이지가 저장되었을 수 있으니
          파일과 LMS 로그인 상태를 확인하세요.
        </Notice>
      )}
    </>
  );
}
