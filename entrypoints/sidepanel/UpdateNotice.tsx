import { useEffect, useState } from "react";

// One request per panel page, shared across StrictMode effect replays: the
// background clears the toolbar badge when it answers.
let taken: Promise<boolean> | undefined;
function takeUpdate(): Promise<boolean> {
  taken ??= (async () => {
    try {
      const result: unknown = await chrome.runtime.sendMessage({
        version: 1,
        type: "UPDATE_NOTICE_TAKE",
      });
      return (
        result !== null &&
        typeof result === "object" &&
        (result as { updated?: unknown }).updated === true
      );
    } catch {
      return false;
    }
  })();
  return taken;
}

export function UpdateNotice() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    let active = true;
    void takeUpdate().then((updated) => {
      if (active && updated) setVisible(true);
    });
    return () => {
      active = false;
    };
  }, []);
  if (!visible) return null;
  return (
    <aside className="notice" aria-label="업데이트 안내">
      <p>
        uniDock이 {chrome.runtime.getManifest?.().version ?? "새"} 버전으로
        업데이트되었습니다.
      </p>
      <div className="tools">
        <a
          className="btn-secondary"
          href="updates.html"
          target="_blank"
          rel="noreferrer"
        >
          변경 사항 보기
        </a>
        <button className="btn-ghost" onClick={() => setVisible(false)}>
          닫기
        </button>
      </div>
    </aside>
  );
}
