import { setSessionAccess, type AccessGrant, type SessionAccess } from "../caption-server-settings";
import { CaptionServerError, type CaptionServerErrorCode } from "./server-http";
import {
  CAPTION_WORK_ALIVE_MS,
  CAPTION_WORK_PORT,
  CaptionWorkError,
  acceptReply,
  mediaReply,
  openReply,
  tokenReply,
  workPortCommand,
  type CommandOutcome,
  type OffscreenRequest,
  type WorkPortMessage,
} from "./work-protocol";
import { CaptionWorkRunner, type WorkerLink } from "./work-runner";

const MAX_FAILED_RECONNECTS = 5;

async function ask<T>(
  request: OffscreenRequest,
  parse: (value: unknown) => T | null,
  repeatable: boolean,
): Promise<T> {
  let value: unknown;
  try {
    value = await chrome.runtime.sendMessage(request);
  } catch {
    // The worker stopped before it answered. Asking again starts a new one,
    // but only a question that is safe to ask twice is repeated.
    if (!repeatable) throw new CaptionWorkError("UNKNOWN");
    value = await chrome.runtime.sendMessage(request).catch(() => undefined);
  }
  const reply = parse(value);
  if (!reply) throw new CaptionWorkError("UNKNOWN");
  return reply;
}

async function grant(request: OffscreenRequest): Promise<AccessGrant | null> {
  const reply = await ask(request, tokenReply, true);
  if (reply.status === "error")
    throw new CaptionServerError(reply.code as CaptionServerErrorCode);
  return reply.grant;
}

/**
 * The document has no storage API and never sees the refresh token: every
 * request borrows an access token from the worker, which stays the only
 * reader and writer of the stored session.
 */
const workerSession: SessionAccess = {
  current: async () => {
    const granted = await grant({ version: 1, type: "CAPTION_OFFSCREEN_TOKEN", action: "current" });
    if (!granted) throw new CaptionServerError("LOGIN_REQUIRED");
    return granted;
  },
  refresh: (used) =>
    grant({
      version: 1,
      type: "CAPTION_OFFSCREEN_TOKEN",
      action: "refresh",
      session: used.id,
      loginId: used.loginId,
    }),
  reject: async (used) => {
    await grant({
      version: 1,
      type: "CAPTION_OFFSCREEN_TOKEN",
      action: "reject",
      session: used.id,
      loginId: used.loginId,
    });
  },
};

/**
 * Runs caption preparation in the offscreen document and keeps one port to the
 * worker. A worker that stops drops the port; the document reconnects at once
 * (which starts a new worker) and, on its "ready", tells it the runs and the
 * rules in use again. While work is in flight a message every
 * CAPTION_WORK_ALIVE_MS keeps the worker running, so it notices at once when
 * this document goes away.
 */
export function startCaptionWork(): void {
  let port: chrome.runtime.Port | null = null;
  let failedReconnects = 0;
  let abandoned = false;
  const rules = new Map<number, string>();
  const adding = new Map<number, (ok: boolean) => void>();
  const removing = new Map<number, () => void>();
  const post = (message: WorkPortMessage) => {
    try {
      port?.postMessage(message);
    } catch {
      // A dropped port is reconnected by its onDisconnect handler.
    }
  };
  const link: WorkerLink = {
    media: (request) =>
      ask({ version: 1, type: "CAPTION_OFFSCREEN_MEDIA", ...request }, mediaReply, true),
    open: (tabId, batch, index) =>
      ask({ version: 1, type: "CAPTION_OFFSCREEN_OPEN", tabId, batch, index }, openReply, false),
    accept: async (jobId, key) => {
      const reply = await ask(
        { version: 1, type: "CAPTION_OFFSCREEN_ACCEPT", jobId, key },
        acceptReply,
        true,
      );
      if (reply.status === "error") throw new CaptionWorkError(reply.code);
    },
    rule: {
      add: (id, mediaUrl) =>
        new Promise<boolean>((resolve) => {
          if (abandoned) return resolve(false);
          rules.set(id, mediaUrl);
          adding.set(id, resolve);
          post({ type: "rule", id, mediaUrl });
        }),
      remove: (id) =>
        new Promise<void>((resolve) => {
          rules.delete(id);
          adding.get(id)?.(false);
          adding.delete(id);
          if (abandoned) return resolve();
          removing.set(id, resolve);
          post({ type: "unrule", id });
        }),
    },
    publish: (work) => post({ type: "work", ...work }),
  };
  const runner = new CaptionWorkRunner(link);
  setSessionAccess(workerSession);

  const abandon = () => {
    abandoned = true;
    for (const resolve of adding.values()) resolve(false);
    for (const resolve of removing.values()) resolve();
    adding.clear();
    removing.clear();
  };
  const connect = () => {
    let current: chrome.runtime.Port;
    try {
      current = chrome.runtime.connect({ name: CAPTION_WORK_PORT });
    } catch {
      abandon();
      return;
    }
    port = current;
    current.onMessage.addListener((message: unknown) => {
      const command = workPortCommand(message);
      if (!command) return;
      switch (command.type) {
        case "ready":
          failedReconnects = 0;
          post({ type: "work", ...runner.snapshot() });
          for (const [id, mediaUrl] of rules) post({ type: "rule", id, mediaUrl });
          for (const id of removing.keys()) post({ type: "unrule", id });
          return;
        case "rule":
          adding.get(command.id)?.(command.ok);
          adding.delete(command.id);
          return;
        case "unrule":
          removing.get(command.id)?.();
          removing.delete(command.id);
          return;
        case "session-ended":
          runner.sessionEnded();
          return;
        case "command":
          void runner
            .command(command.command)
            .catch((): CommandOutcome => ({ status: "error", code: "UNKNOWN" }))
            .then((outcome) => post({ type: "reply", id: command.id, ...outcome }));
      }
    });
    current.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      if (port !== current) return;
      port = null;
      if (failedReconnects++ < MAX_FAILED_RECONNECTS) connect();
      else abandon();
    });
  };
  connect();
  setInterval(() => {
    if (runner.busy()) post({ type: "alive" });
  }, CAPTION_WORK_ALIVE_MS);
}
