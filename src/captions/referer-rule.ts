import { allowedCaptionMediaUrl, CAPTION_MEDIA_HOST } from "../security/policy";
import { safeLog } from "../security/logger";

export const CAPTION_RULE_PORT = "unidock-caption-rule";
const RULE_ID_MIN = 1_947_000;
const RULE_ID_SPAN = 1000;
const PLAYER_REFERER = "https://kucom.korea.ac.kr/";
const MAX_RECONNECTS = 20;
export const CAPTION_RULE_SWEEP_GRACE_MS = 10_000;

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
 * If the worker restarts, the port drops and the panel reconnects under the
 * same name so the new worker sees the rule as live.
 */
export async function withCaptionMediaRule<T>(
  mediaUrl: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (!allowedCaptionMediaUrl(mediaUrl)) throw new Error("UNSUPPORTED_MEDIA");
  const id =
    RULE_ID_MIN + (crypto.getRandomValues(new Uint32Array(1))[0]! % RULE_ID_SPAN);
  const name = `${CAPTION_RULE_PORT}:${id}`;
  let finished = false;
  let reconnects = 0;
  let port!: chrome.runtime.Port;
  const connect = () => {
    port = chrome.runtime.connect({ name });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      if (!finished && reconnects++ < MAX_RECONNECTS) connect();
    });
  };
  connect();
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      addRules: [rule(mediaUrl, id)],
    });
    return await fn();
  } finally {
    finished = true;
    await removeRules([id]);
    port.disconnect();
  }
}

/**
 * Background side. A rule is removed when its panel port disconnects (panel
 * closed or crashed). On worker start, rules whose panel has not reconnected
 * within the grace period are removed, so no exit path leaves a rule behind
 * and a restart never removes a rule a panel is still using.
 */
export function installCaptionRuleCleanup(
  fromPanel: (sender: chrome.runtime.MessageSender) => boolean,
  graceMs = CAPTION_RULE_SWEEP_GRACE_MS,
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
  return new Promise<void>((resolve) => setTimeout(resolve, graceMs))
    .then(() => chrome.declarativeNetRequest.getSessionRules())
    .then(
    (rules) =>
      removeRules(
        rules.map((r) => r.id).filter((id) => isCaptionRuleId(id) && !live.has(id)),
      ),
    () => safeLog("REQUEST_FAILED"),
  );
}
