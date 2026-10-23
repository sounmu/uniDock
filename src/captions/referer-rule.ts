import { allowedCaptionMediaUrl, CAPTION_MEDIA_HOST } from "../security/policy";
import { safeLog } from "../security/logger";

export const CAPTION_RULE_PORT = "unidock-caption-rule";
const RULE_ID_MIN = 1_947_000;
const RULE_ID_SPAN = 1000;
const PLAYER_REFERER = "https://kucom.korea.ac.kr/";
const MAX_FAILED_RECONNECTS = 5;
export const CAPTION_RULE_KEEPALIVE_MS = 20_000;
export const CAPTION_RULE_SWEEP_GRACE_MS = 10_000;

const isReady = (message: unknown) =>
  (message as { type?: unknown } | null)?.type === "ready";

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
 * While it runs the panel posts a keepalive on the port, because since Chrome
 * 114 an open port alone does not keep the worker alive. If the worker still
 * restarts, the port drops and the panel reconnects under the same name; each
 * worker answers "ready", which resets the failure count and makes the panel
 * re-add the same rule in case a sweep removed it.
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
  let ruleAdded = false;
  let failedReconnects = 0;
  let port!: chrome.runtime.Port;
  const reassert = async () => {
    if (finished || !ruleAdded) return;
    try {
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [id],
        addRules: [rule(mediaUrl, id)],
      });
    } catch {
      safeLog("REQUEST_FAILED");
    }
  };
  const connect = () => {
    const current = chrome.runtime.connect({ name });
    port = current;
    current.onMessage.addListener((message: unknown) => {
      if (!isReady(message)) return;
      failedReconnects = 0;
      void reassert();
    });
    current.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      if (!finished && failedReconnects++ < MAX_FAILED_RECONNECTS) connect();
    });
  };
  connect();
  const keepalive = setInterval(() => {
    try {
      port.postMessage({ type: "keepalive" });
    } catch {
      // A dropped port is reconnected by its onDisconnect handler.
    }
  }, CAPTION_RULE_KEEPALIVE_MS);
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      addRules: [rule(mediaUrl, id)],
    });
    ruleAdded = true;
    return await fn();
  } finally {
    finished = true;
    clearInterval(keepalive);
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
    // Keepalive messages need no reply; receiving them keeps the worker alive.
    port.onMessage.addListener(() => undefined);
    port.postMessage({ type: "ready" });
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
