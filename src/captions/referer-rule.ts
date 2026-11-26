import { allowedCaptionMediaUrl, CAPTION_MEDIA_HOST } from "../security/policy";
import { safeLog } from "../security/logger";
import { KOREA_ORIGINS } from "../security/origins";
import {
  CAPTION_RULE_ID_MIN,
  CAPTION_RULE_ID_SPAN,
  isCaptionRuleId,
} from "./work-protocol";

const PLAYER_REFERER = `${KOREA_ORIGINS.player}/`;
export const CAPTION_RULE_SWEEP_GRACE_MS = 10_000;

function rule(mediaUrl: string, id: number): chrome.declarativeNetRequest.Rule {
  return {
    id,
    priority: 1,
    action: {
      type: "modifyHeaders" as chrome.declarativeNetRequest.RuleActionType,
      requestHeaders: [
        {
          header: "referer",
          operation: "set" as chrome.declarativeNetRequest.HeaderOperation,
          value: PLAYER_REFERER,
        },
      ],
    },
    condition: {
      urlFilter: `|${mediaUrl}|`,
      requestDomains: [CAPTION_MEDIA_HOST],
      initiatorDomains: [chrome.runtime.id],
      resourceTypes: [
        "xmlhttprequest" as chrome.declarativeNetRequest.ResourceType,
      ],
    },
  };
}

/** Whether Chrome removed the rules; a refused removal leaves them installed. */
async function removeRules(ids: number[]): Promise<boolean> {
  if (!ids.length) return true;
  try {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids });
    return true;
  } catch {
    safeLog("REQUEST_FAILED");
    return false;
  }
}

/** How the offscreen document, which has no declarativeNetRequest API, asks the worker for its rule. */
export interface CaptionRuleChannel {
  /** Resolves once the worker installed the rule; false when it could not. */
  add(id: number, mediaUrl: string): Promise<boolean>;
  remove(id: number): Promise<void>;
}

/**
 * Run `fn` while a session rule sets Referer on the extension's own request
 * for exactly `mediaUrl`. The rule is removed on success, failure and cancel.
 * The channel keeps it alive across worker restarts and the worker removes it
 * when the document goes away.
 */
export async function withCaptionMediaRule<T>(
  mediaUrl: string,
  channel: CaptionRuleChannel,
  fn: () => Promise<T>,
): Promise<T> {
  if (!allowedCaptionMediaUrl(mediaUrl)) throw new Error("UNSUPPORTED_MEDIA");
  const id =
    CAPTION_RULE_ID_MIN +
    (crypto.getRandomValues(new Uint32Array(1))[0]! % CAPTION_RULE_ID_SPAN);
  try {
    if (!(await channel.add(id, mediaUrl))) throw new Error("RULE");
    return await fn();
  } finally {
    await channel.remove(id);
  }
}

/**
 * Worker side: the only caller of declarativeNetRequest for caption media.
 * A rule lives while the document that asked for it holds its port: `clear`
 * runs when that port drops. Session rules outlive a worker, so a new worker
 * removes the ones its document has not asked for again within the grace
 * period: no exit path leaves a rule behind, and a restart never removes a
 * rule still in use.
 */
export class CaptionMediaRules {
  private readonly live = new Set<number>();

  async add(id: number, mediaUrl: string): Promise<boolean> {
    if (!isCaptionRuleId(id) || !allowedCaptionMediaUrl(mediaUrl)) return false;
    this.live.add(id);
    try {
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [id],
        addRules: [rule(mediaUrl, id)],
      });
      return true;
    } catch {
      this.live.delete(id);
      safeLog("REQUEST_FAILED");
      return false;
    }
  }

  // A rule Chrome did not remove stays listed, so the next `clear` tries again.
  async remove(id: number): Promise<void> {
    if (await removeRules([id])) this.live.delete(id);
  }

  async clear(): Promise<void> {
    const ids = [...this.live];
    if (await removeRules(ids)) for (const id of ids) this.live.delete(id);
  }

  sweep(graceMs = CAPTION_RULE_SWEEP_GRACE_MS): Promise<void> {
    return new Promise<void>((resolve) => setTimeout(resolve, graceMs))
      .then(() => chrome.declarativeNetRequest.getSessionRules())
      .then(
        async (rules) => {
          await removeRules(
            rules
              .map((r) => r.id)
              .filter((id) => isCaptionRuleId(id) && !this.live.has(id)),
          );
        },
        () => safeLog("REQUEST_FAILED"),
      );
  }
}
