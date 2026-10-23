import { allowedCaptionMediaUrl, CAPTION_MEDIA_HOST } from "../security/policy";
import { safeLog } from "../security/logger";

export const CAPTION_RULE_PORT = "unidock-caption-rule";
const RULE_ID_MIN = 1_947_000;
const RULE_ID_SPAN = 1000;
const PLAYER_REFERER = "https://kucom.korea.ac.kr/";

const isCaptionRuleId = (id: number) =>
  Number.isInteger(id) && id >= RULE_ID_MIN && id < RULE_ID_MIN + RULE_ID_SPAN;

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

async function removeRules(ids: number[]): Promise<void> {
  if (!ids.length) return;
  try {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids });
  } catch {
    safeLog("REQUEST_FAILED");
  }
}

/**
 * Run `fn` with a session rule that sets Referer on the extension's own request
 * for exactly `mediaUrl`. The panel removes the rule on success, failure and
 * cancel; the open port lets the background remove it if the panel closes.
 */
export async function withCaptionMediaRule<T>(
  mediaUrl: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (!allowedCaptionMediaUrl(mediaUrl)) throw new Error("UNSUPPORTED_MEDIA");
  const id =
    RULE_ID_MIN + (crypto.getRandomValues(new Uint32Array(1))[0]! % RULE_ID_SPAN);
  const port = chrome.runtime.connect({ name: `${CAPTION_RULE_PORT}:${id}` });
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      addRules: [rule(mediaUrl, id)],
    });
    return await fn();
  } finally {
    await removeRules([id]);
    port.disconnect();
  }
}

/**
 * Background side. A rule is removed when its panel port disconnects (panel
 * closed or crashed), and on worker start any rule without a live port is
 * removed, so no exit path leaves a rule behind.
 */
export function installCaptionRuleCleanup(
  fromPanel: (sender: chrome.runtime.MessageSender) => boolean,
): Promise<void> {
  const live = new Set<number>();
  chrome.runtime.onConnect.addListener((port) => {
    const match = /^unidock-caption-rule:(\d+)$/.exec(port.name);
    if (!match) return;
    const id = Number(match[1]);
    if (!isCaptionRuleId(id) || !port.sender || !fromPanel(port.sender)) {
      port.disconnect();
      return;
    }
    live.add(id);
    port.onDisconnect.addListener(() => {
      live.delete(id);
      void removeRules([id]);
    });
  });
  return chrome.declarativeNetRequest.getSessionRules().then(
    (rules) =>
      removeRules(
        rules.map((r) => r.id).filter((id) => isCaptionRuleId(id) && !live.has(id)),
      ),
    () => safeLog("REQUEST_FAILED"),
  );
}
