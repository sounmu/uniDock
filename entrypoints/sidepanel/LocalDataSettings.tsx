import { useState } from "react";

export function LocalDataSettings() {
  const [confirm, setConfirm] = useState(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  async function erase() {
    setPending(true);
    try {
      const result = await chrome.runtime.sendMessage({
        version: 1,
        type: "LOCAL_DATA_DELETE_ALL",
      });
      if (result?.status !== "success") throw new Error("STORAGE");
      setConfirm(false);
      setNotice(
        "로컬 데이터를 삭제했습니다. 이미 전송된 통계는 별도 삭제 요청이 필요합니다.",
      );
    } catch {
      setNotice("로컬 데이터를 삭제하지 못했습니다. 다시 시도하세요.");
    } finally {
      setPending(false);
    }
  }
  return (
    <section className="notice" aria-label="로컬 데이터">
      <h3>로컬 데이터</h3>
      <p className="hint">
        통계 동의와 설치 식별자 등 저장된 설정을 삭제합니다. 다운로드한 파일은
        유지됩니다.
      </p>
      {confirm ? (
        <div className="tools">
          <button
            className="btn-secondary"
            disabled={pending}
            onClick={() => void erase()}
          >
            삭제 확인
          </button>
          <button
            className="btn-ghost"
            disabled={pending}
            onClick={() => setConfirm(false)}
          >
            취소
          </button>
        </div>
      ) : (
        <button className="btn-secondary" onClick={() => setConfirm(true)}>
          로컬 데이터 모두 삭제
        </button>
      )}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
