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

interface DocumentProvenance {
  documentId: string;
  frameId: number;
  pageUrl: string;
}

function validPageUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value) return false;
  try {
    return new URL(value).href === value;
  } catch {
    return false;
  }
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
      if (
        !top?.documentId ||
        !validPageUrl(top.result?.pageUrl) ||
        typeof top.frameId !== "number"
      )
        return { status: "error", code: "RELOAD_TAB" };
      if (dom.length > 20) return { status: "error", code: "UNSAFE_CAPTION" };
      const isolated = new Map<string, DocumentProvenance>();
      for (const batch of dom) {
        if (
          !batch.documentId ||
          typeof batch.frameId !== "number" ||
          !validPageUrl(batch.result?.pageUrl)
        )
          continue;
        isolated.set(batch.documentId, {
          documentId: batch.documentId,
          frameId: batch.frameId,
          pageUrl: batch.result.pageUrl,
        });
      }
      const topProvenance = isolated.get(top.documentId);
      if (!topProvenance || topProvenance.frameId !== 0)
        return { status: "error", code: "RELOAD_TAB" };
      const knownInjection = (batch: {
        documentId?: string;
        frameId: number;
      }): DocumentProvenance | undefined => {
        if (!batch.documentId) return undefined;
        const provenance = isolated.get(batch.documentId);
        return provenance?.frameId === batch.frameId ? provenance : undefined;
      };
      const allTargeted = (
        batches: { documentId?: string; frameId: number }[],
        documentIds: string[],
      ) =>
        batches.length === documentIds.length &&
        batches.every(
          (batch) =>
            !!knownInjection(batch) &&
            !!batch.documentId &&
            documentIds.includes(batch.documentId),
        ) &&
        documentIds.every(
          (documentId) =>
            batches.filter((batch) => batch.documentId === documentId).length ===
            1,
        );
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
          let player;
          try {
            player = await chrome.scripting.executeScript({
              target: { tabId: id, documentIds: playerDocuments },
              world: "MAIN",
              func: collectCaptionSources,
              args: ["player", deadline],
            });
          } catch {
            return { status: "error", code: "RELOAD_TAB" };
          }
          if (timedOut()) return { status: "error", code: "TIMEOUT" };
          if (!allTargeted(player, playerDocuments))
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
            let scripts;
            try {
              scripts = await chrome.scripting.executeScript({
                target: { tabId: id, documentIds: playerDocuments },
                world: "MAIN",
                func: collectCaptionSources,
                args: ["script"],
              });
            } catch {
              return { status: "error", code: "RELOAD_TAB" };
            }
            if (timedOut()) return { status: "error", code: "TIMEOUT" };
            if (!allTargeted(scripts, playerDocuments))
              return { status: "error", code: "RELOAD_TAB" };
            blocked ||= scripts.some(
              (batch) => batch.result?.blocked || batch.result?.limited,
            );
            chosen = scripts.filter((batch) => batch.result?.script);
          }
        }
      }
      const captions: Caption[] = [];
      const contributors = new Map<string, DocumentProvenance>();
      let total = 0;
      for (const batch of chosen) {
        const row = batch.result;
        const provenance = knownInjection(batch);
        if (!row || row.limited || !provenance) {
          if (!provenance) return { status: "error", code: "RELOAD_TAB" };
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
          contributors.set(provenance.documentId, provenance);
        } catch {
          blocked = true;
        }
      }
      // Verify all contributing documents still exist, including the outer lecture page.
      contributors.set(topProvenance.documentId, topProvenance);
      const documentIds = [...contributors.keys()];
      if (timedOut()) return { status: "error", code: "TIMEOUT" };
      let verified;
      try {
        verified = await chrome.scripting.executeScript({
          target: { tabId: id, documentIds },
          world: "ISOLATED",
          func: () => location.href,
        });
      } catch {
        return { status: "error", code: "RELOAD_TAB" };
      }
      if (timedOut()) return { status: "error", code: "TIMEOUT" };
      const current = await chrome.tabs.get(id);
      if (timedOut()) return { status: "error", code: "TIMEOUT" };
      if (
        current.url !== tab.url ||
        verified.length !== contributors.size ||
        verified.some((batch) => {
          if (!batch.documentId || !validPageUrl(batch.result)) return true;
          const expected = contributors.get(batch.documentId);
          return (
            !expected ||
            batch.frameId !== expected.frameId ||
            batch.result !== expected.pageUrl
          );
        }) ||
        documentIds.some(
          (documentId) =>
            !verified.some((batch) => batch.documentId === documentId),
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
