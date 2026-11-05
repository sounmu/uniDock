import type { Transcript } from "../../src/captions/transcript";

/** Cached captions prioritize reading; export actions stay in a compact toolbar. */
export function AiCaptionReader({
  transcript,
  notice,
  onExport,
  onCopy,
}: {
  readonly transcript: Transcript;
  readonly notice: string;
  readonly onExport: (format: "txt" | "json") => void;
  readonly onCopy: () => void;
}) {
  return (
    <div className="ai-job ai-reader">
      <header className="ai-job-head">
        <div className="ai-job-heading">
          <h3 id="ai-offer-title">{transcript.pageTitle}</h3>
          <p>저장된 자막 · {transcript.itemCount.toLocaleString("ko-KR")}문장</p>
        </div>
      </header>
      <div className="ai-reader-tools" role="group" aria-label="자막 저장 및 복사">
        <button className="btn-ghost" onClick={() => onExport("txt")}>TXT 받기</button>
        <button className="btn-ghost" onClick={() => onExport("json")}>JSON 받기</button>
        <button className="btn-ghost" onClick={onCopy}>전체 복사</button>
      </div>
      {notice && <p className="ai-notice" role="status">{notice}</p>}
      <ol className="ai-reader-text" aria-label="전체 자막" tabIndex={0}>
        {transcript.items.map((item) => (
          <li key={item.index}>
            <time>{item.time}</time>
            <span>{item.text}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
