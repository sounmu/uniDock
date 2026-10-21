import { useEffect, useRef, useState, type RefObject } from "react";
import type { Result } from "../../src/protocol";
import type { Document } from "../../src/documents";
import { documentMimeMatches } from "../../src/documents";
import { queryActive, type QueryTarget } from "../../src/transport";
import {
  lmsFileDownloadUrl,
  safeDownloadPath,
} from "../../src/security/download";
import type { QueryGate } from "./query-gate";
import { featureResult } from "./analytics";

export type DownloadStatus =
  "queued" | "requested" | "complete" | "failed" | "cancelled" | "review";
export const downloadLabels: Record<DownloadStatus, string> = {
  queued: "다운로드 중",
  requested: "요청됨",
  complete: "완료",
  failed: "실패",
  cancelled: "취소됨",
  review: "확인 필요",
};
type Expected = {
  readonly handle: string;
  readonly path: string;
  readonly origin: string;
};
export function useDocumentDownloads(context: {
  readonly gate: QueryGate;
  readonly generation: RefObject<number>;
  readonly inFlight: RefObject<Promise<Result> | null>;
  readonly target: RefObject<QueryTarget | null>;
  readonly course: string;
}) {
  const [statuses, setStatuses] = useState<
    Readonly<Record<string, DownloadStatus>>
  >({});
  const [progress, setProgress] = useState({
    running: false,
    done: 0,
    total: 0,
  });
  const [notice, setNotice] = useState("");
  const batch = useRef(0);
  const running = useRef(false);
  const used = useRef(new Set<string>());
  const expected = useRef<Expected[]>([]);
  const candidates = useRef(new Set<number>());
  const bindings = useRef(new Map<number, string>());
  const observed = useRef(new Map<string, DownloadStatus>());
  // Unlike batch cancellation, a list reset retires browser observations too.
  const observationEpoch = useRef(0);
  const source = useRef(context);
  source.current = context;
  useEffect(() => {
    let active = true;
    const observe = (item: chrome.downloads.DownloadItem) => {
      if (
        !active ||
        item.byExtensionId !== chrome.runtime.id ||
        !lmsFileDownloadUrl(item.url, item.url)
      )
        return;
      const path = item.filename.replace(/\\/g, "/");
      // conflictAction "uniquify" saves a repeated file as "name (1).pdf".
      const paths = [path, path.replace(/ \(\d+\)(?=(?:\.[^./]*)?$)/, "")];
      const matches = expected.current.filter(
        (entry) =>
          new URL(item.url).origin === entry.origin &&
          paths.some(
            (candidate) =>
              candidate === entry.path || candidate.endsWith(`/${entry.path}`),
          ),
      );
      const handle =
        bindings.current.get(item.id) ??
        (matches.length === 1 ? matches[0]?.handle : undefined);
      if (!handle) return;
      // A second browser download with the same label cannot claim this handle.
      if (
        [...bindings.current].some(
          ([id, value]) => id !== item.id && value === handle,
        )
      )
        return;
      bindings.current.set(item.id, handle);
      const state: DownloadStatus =
        item.state === "interrupted"
          ? "failed"
          : item.state === "complete"
            ? documentMimeMatches(
                expected.current.find((entry) => entry.handle === handle)
                  ?.path ?? "",
                item.mime,
              )
              ? "complete"
              : "review"
            : "requested";
      observed.current.set(handle, state);
      setStatuses((previous) => ({ ...previous, [handle]: state }));
    };
    const created = (item: chrome.downloads.DownloadItem) => {
      // Chrome may add extension attribution after onCreated. Keep only LMS
      // candidates here; observe still requires verified ownership and path.
      if (
        (item.byExtensionId !== undefined &&
          item.byExtensionId !== chrome.runtime.id) ||
        !lmsFileDownloadUrl(item.url, item.url) ||
        !expected.current.some(
          (entry) => entry.origin === new URL(item.url).origin,
        )
      )
        return;
      candidates.current.add(item.id);
      observe(item);
    };
    const changed = (delta: chrome.downloads.DownloadDelta) => {
      if (!candidates.current.has(delta.id)) return;
      const epoch = observationEpoch.current;
      void chrome.downloads.search({ id: delta.id }).then(
        (items) => {
          if (
            !active ||
            epoch !== observationEpoch.current ||
            !candidates.current.has(delta.id)
          )
            return;
          for (const item of items) observe(item);
        },
        () => {
          if (
            active &&
            epoch === observationEpoch.current &&
            candidates.current.has(delta.id)
          )
            setNotice(
              "다운로드 상태를 확인하지 못했습니다. 브라우저 다운로드 목록을 확인하세요.",
            );
        },
      );
    };
    chrome.downloads.onCreated.addListener(created);
    chrome.downloads.onChanged.addListener(changed);
    return () => {
      active = false;
      observationEpoch.current++;
      batch.current++;
      chrome.downloads.onCreated.removeListener(created);
      chrome.downloads.onChanged.removeListener(changed);
    };
  }, []);
  function reset() {
    observationEpoch.current++;
    batch.current++;
    used.current.clear();
    expected.current = [];
    candidates.current.clear();
    bindings.current.clear();
    observed.current.clear();
    setStatuses({});
    setProgress({ running: false, done: 0, total: 0 });
    setNotice("");
  }
  async function downloadDocuments(
    documents: readonly Document[],
    handles: readonly string[],
  ) {
    const { gate, generation, inFlight, target, course } = source.current;
    const destination = target.current;
    if (running.current || inFlight.current || !destination) return;
    const selected = documents.filter(
      (item) =>
        item.downloadHandle &&
        handles.includes(item.downloadHandle) &&
        !used.current.has(item.downloadHandle),
    );
    if (!selected.length) return;
    const report = featureResult("download");
    const current = generation.current,
      token = ++batch.current;
    running.current = true;
    setNotice("");
    setProgress({ running: true, done: 0, total: selected.length });
    setStatuses((previous) => ({
      ...previous,
      ...Object.fromEntries(
        selected.map((item) => [item.downloadHandle, "queued" as const]),
      ),
    }));
    let done = 0;
    for (const item of selected) {
      if (current !== generation.current || token !== batch.current) break;
      const lease = await gate.acquire();
      if (current !== generation.current || token !== batch.current) {
        lease.release();
        break;
      }
      const handle = item.downloadHandle;
      used.current.add(handle);
      const path = safeDownloadPath(course, item.module, item.filename);
      if (path)
        expected.current.push({
          handle,
          path,
          origin: new URL(destination.url).origin,
        });
      const work = queryActive(
        { version: 1, type: "DOCUMENT_DOWNLOAD", handle, course },
        { target: destination },
      );
      inFlight.current = work;
      const result = await work.finally(lease.release);
      if (inFlight.current === work) inFlight.current = null;
      if (
        result.status === "error" &&
        (result.code === "RATE_LIMITED" || result.code === "BUSY")
      ) {
        // Refused before use: the content script kept this handle. Stop the
        // batch; it and the rest stay queued, end as cancelled, and remain
        // selectable for a retry from this same list.
        used.current.delete(handle);
        expected.current = expected.current.filter(
          (entry) => entry.handle !== handle,
        );
        if (current === generation.current)
          setNotice(
            result.code === "RATE_LIMITED"
              ? "짧은 시간에 다운로드 요청이 많아 일시 중지했습니다. 1분 뒤 남은 자료를 다시 다운로드하세요."
              : "이전 요청을 처리하고 있어 다운로드를 멈췄습니다. 잠시 후 남은 자료를 다시 다운로드하세요.",
          );
        break;
      }
      report(result.status === "success");
      done++;
      if (current !== generation.current) break;
      const observedState = observed.current.get(handle);
      setStatuses((previous) => ({
        ...previous,
        [handle]:
          result.status === "success"
            ? previous[handle] === "queued"
              ? "requested"
              : (previous[handle] ?? "requested")
            : (observedState ?? "failed"),
      }));
      if (result.status === "error" && observedState === undefined)
        setNotice(
          result.code === "STALE_SELECTION"
            ? "목록을 새로고침한 뒤 다시 다운로드하세요."
            : "자료 다운로드를 시작하지 못했습니다. 목록을 다시 조회한 뒤 시도하세요.",
        );
      setProgress({ running: true, done, total: selected.length });
    }
    running.current = false;
    // Keep cancelled labels if this list is retained; never overwrite a new list.
    if (current === generation.current) {
      setStatuses((previous) =>
        Object.fromEntries(
          Object.entries(previous).map(([handle, state]) => [
            handle,
            state === "queued" ? "cancelled" : state,
          ]),
        ),
      );
      setProgress({ running: false, done, total: selected.length });
    }
  }
  return {
    statuses,
    progress,
    notice,
    reset,
    downloadDocuments,
    cancel: () => {
      batch.current++;
      setStatuses((previous) =>
        Object.fromEntries(
          Object.entries(previous).map(([handle, state]) => [
            handle,
            state === "queued" && !used.current.has(handle)
              ? "cancelled"
              : state,
          ]),
        ),
      );
      // The in-flight request still owns the batch; the loop clears running.
      if (!running.current)
        setProgress((previous) => ({ ...previous, running: false }));
    },
  };
}
