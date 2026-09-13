import { collectCaptionSources } from "./extract";
import {
  normalizeItems,
  parseVtt,
  parseMediaScript,
  type Transcript,
} from "./transcript";
export interface Caption extends Transcript {
  label: string;
  source: string;
}
export type CaptionResult =
  | { status: "success"; captions: Caption[]; blocked: boolean }
  | {
      status: "error";
      code:
        | "ACTIVATE_TAB"
        | "NO_CAPTIONS"
        | "UNSAFE_CAPTION"
        | "TIMEOUT"
        | "RELOAD_TAB";
    };
export interface CaptionTarget {
  tabId: number;
  windowId: number;
}
export async function detectCaptions(
  onTarget?: (target: CaptionTarget) => boolean,
): Promise<CaptionResult> {
  const deadline = Date.now() + 15000;
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = () => expired || Date.now() >= deadline;
  try {
    const timeout = new Promise<CaptionResult>((resolve) => {
      timer = setTimeout(
        () => {
          expired = true;
          resolve({ status: "error", code: "TIMEOUT" });
        },
        Math.max(0, deadline - Date.now()),
      );
    });
    const tabs = await Promise.race([
      chrome.tabs.query({ active: true, currentWindow: true }),
      timeout,
    ]);
    if (!Array.isArray(tabs)) return tabs;
    if (timedOut()) return { status: "error", code: "TIMEOUT" };
    const [tab] = tabs;
    if (
      tab?.id === undefined ||
      !tab.url ||
      new URL(tab.url).protocol !== "https:"
    )
      return { status: "error", code: "ACTIVATE_TAB" };
    const id = tab.id;
    if (onTarget && !onTarget({ tabId: id, windowId: tab.windowId }))
      return { status: "error", code: "RELOAD_TAB" };
    const work = async (): Promise<CaptionResult> => {
      if (timedOut()) return { status: "error", code: "TIMEOUT" };
      const dom = await chrome.scripting.executeScript({
        target: { tabId: id, allFrames: true },
        world: "ISOLATED",
        func: collectCaptionSources,
        args: ["dom"],
      });
      if (timedOut()) return { status: "error", code: "TIMEOUT" };
      const top = dom.find((batch) => batch.frameId === 0);
      if (!top?.documentId) return { status: "error", code: "RELOAD_TAB" };
      if (dom.length > 20) return { status: "error", code: "UNSAFE_CAPTION" };
      let blocked = dom.some(
        (batch) => batch.result?.blocked || batch.result?.limited,
      );
      let chosen = dom.filter((batch) => batch.result?.items.length);
      if (!chosen.length) {
        const playerDocuments = dom
          .filter((batch) => {
            try {
              const url = new URL(batch.result?.pageUrl ?? "");
              return (
                url.origin === "https://kucom.korea.ac.kr" &&
                url.pathname.startsWith("/em/") &&
                batch.documentId
              );
            } catch {
              return false;
            }
          })
          .map((batch) => batch.documentId!);
        if (playerDocuments.length) {
          if (timedOut()) return { status: "error", code: "TIMEOUT" };
          const player = await chrome.scripting.executeScript({
            target: { tabId: id, documentIds: playerDocuments },
            world: "MAIN",
            func: collectCaptionSources,
            args: ["player", deadline],
          });
          if (timedOut()) return { status: "error", code: "TIMEOUT" };
          if (
            player.some(
              (batch) =>
                !batch.documentId ||
                !playerDocuments.includes(batch.documentId),
            )
          )
            return { status: "error", code: "RELOAD_TAB" };
          blocked ||= player.some(
            (batch) => batch.result?.blocked || batch.result?.limited,
          );
          chosen = player.filter((batch) => {
            if (!batch.result?.vtt) return false;
            try {
              return parseVtt(batch.result.vtt).length > 0;
            } catch {
              blocked = true;
              return false;
            }
          });
          if (!chosen.length) {
            if (timedOut()) return { status: "error", code: "TIMEOUT" };
            const scripts = await chrome.scripting.executeScript({
              target: { tabId: id, documentIds: playerDocuments },
              world: "MAIN",
              func: collectCaptionSources,
              args: ["script"],
            });
            if (timedOut()) return { status: "error", code: "TIMEOUT" };
            if (
              scripts.some(
                (batch) =>
                  !batch.documentId ||
                  !playerDocuments.includes(batch.documentId),
              )
            )
              return { status: "error", code: "RELOAD_TAB" };
            blocked ||= scripts.some(
              (batch) => batch.result?.blocked || batch.result?.limited,
            );
            chosen = scripts.filter((batch) => batch.result?.script);
          }
        }
      }
      const captions: Caption[] = [];
      let total = 0;
      for (const batch of chosen) {
        const row = batch.result;
        if (!row || row.limited || !batch.documentId) {
          blocked = true;
          continue;
        }
        try {
          const items =
            row.source === "caption_script_dom"
              ? normalizeItems(row.items)
              : row.source === "player_media_script"
                ? parseMediaScript(row.script)
                : parseVtt(row.vtt);
          if (!items.length) continue;
          const fingerprint = JSON.stringify(items);
          if (
            captions.some(
              (caption) => JSON.stringify(caption.items) === fingerprint,
            )
          )
            continue;
          total += fingerprint.length;
          if (total > 2000000) throw new Error("LIMIT");
          captions.push({
            sourceUrl: tab.url!,
            pageTitle:
              tab.title || top.result?.pageTitle || row.pageTitle || "강의",
            extractedAt: new Date().toISOString(),
            itemCount: items.length,
            items,
            label: row.label || "화면 자막",
            source: row.source,
          });
        } catch {
          blocked = true;
        }
      }
      // Verify all contributing documents still exist, including the outer lecture page.
      const documentIds = [
        ...new Set([
          top.documentId,
          ...chosen.map((batch) => batch.documentId!),
        ]),
      ];
      if (timedOut()) return { status: "error", code: "TIMEOUT" };
      const verified = await chrome.scripting.executeScript({
        target: { tabId: id, documentIds },
        world: "ISOLATED",
        func: () => location.href,
      });
      if (timedOut()) return { status: "error", code: "TIMEOUT" };
      const current = await chrome.tabs.get(id);
      if (timedOut()) return { status: "error", code: "TIMEOUT" };
      if (
        current.url !== tab.url ||
        documentIds.some(
          (doc) => !verified.some((batch) => batch.documentId === doc),
        )
      )
        return { status: "error", code: "RELOAD_TAB" };
      if (!captions.length)
        return {
          status: "error",
          code: blocked ? "UNSAFE_CAPTION" : "NO_CAPTIONS",
        };
      return { status: "success", captions, blocked };
    };
    return await Promise.race([work(), timeout]);
  } catch {
    return { status: "error", code: "ACTIVATE_TAB" };
  } finally {
    clearTimeout(timer);
  }
}
