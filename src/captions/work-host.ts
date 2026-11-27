import { storedSessionAccess, type AccessGrant } from "../caption-server-settings";
import { lectureTabKey } from "../open-tab";
import { parseResult, type Request, type Result } from "../protocol";
import { safeLog } from "../security/logger";
import { allowedPage } from "../security/policy";
import { cancelJob } from "./job-client";
import type { CaptionJobMonitor } from "./job-monitor";
import { captionJobKey, saveActiveJob } from "./job-record";
import { identifyMedia, type MediaSource } from "./media-source";
import type { CaptionMediaRules } from "./referer-rule";
import {
  LOST_SELECTION,
  MAX_WORK_TITLE,
  NO_RUNS,
  OFFSCREEN_PATH,
  errorCode,
  preparingPhase,
  workBusy,
  workPortMessage,
  type AcceptReply,
  type CaptionWorkCommand,
  type CaptionWorkReply,
  type CaptionWorkState,
  type CommandOutcome,
  type LectureMedia,
  type MediaReply,
  type OffscreenRequest,
  type OpenReply,
  type RunCommand,
  type TokenReply,
  type WorkPortCommand,
  type WorkPortMessage,
  type WorkRuns,
} from "./work-protocol";

/**
 * No offscreen reason names work that must outlive the page that started it.
 * BLOBS is the one that is true of this document: it assembles a lecture's
 * audio as a Blob of up to 200 MB and uploads slices of it. A service worker
 * can be stopped in the middle and would lose that Blob.
 */
const REASON = "BLOBS";
const JUSTIFICATION =
  "Holds a lecture's extracted audio as a Blob and uploads it to the caption server, so the upload finishes after the side panel closes.";
export const DOCUMENT_CONNECT_MS = 10_000;
export const COMMAND_TIMEOUT_MS = 30_000;
export const OPEN_TIMEOUT_MS = 25_000;
/** A lecture check reads the lecture tab twice; one that hangs is a mismatch. */
export const VERIFY_TIMEOUT_MS = 10_000;
/** A run whose document went away before the server had its audio. */
const INTERRUPTED = "UNKNOWN";

export interface WorkHostOptions {
  readonly monitor: Pick<CaptionJobMonitor, "track">;
  readonly rules: Pick<CaptionMediaRules, "add" | "remove" | "clear">;
  readonly onWork: (runs: WorkRuns) => void;
}

async function savedLectureTab(source: number): Promise<number | null> {
  const key = lectureTabKey(source);
  const saved: unknown = (await chrome.storage.session.get(key))[key];
  return typeof saved === "number" ? saved : null;
}

async function lecture(source: MediaSource): Promise<LectureMedia> {
  return {
    mediaUrl: source.mediaUrl,
    durationS: source.durationS,
    key: await captionJobKey(source.contentId),
    title: source.title.slice(0, MAX_WORK_TITLE),
    tabId: source.tabId,
    documentId: source.documentId,
  };
}

function interrupted(runs: WorkRuns): WorkRuns {
  const { single, queue } = runs;
  return {
    single:
      single && preparingPhase(single.phase)
        ? { ...single, phase: "failed", errorCode: INTERRUPTED }
        : single,
    queue: queue?.running
      ? {
          ...queue,
          running: false,
          items: queue.items.map((item) =>
            item.phase === "waiting"
              ? { ...item, phase: "cancelled" }
              : item.phase === "opening" || preparingPhase(item.phase)
                ? { ...item, phase: "failed", errorCode: INTERRUPTED }
                : item,
          ),
        }
      : queue,
  };
}

/**
 * Worker side of caption preparation. It owns the offscreen document (created
 * for a start command, closed as soon as it reports nothing in flight) and the
 * state panel pages see, and does for the document what needs an extension
 * API: tabs, scripting, storage and declarativeNetRequest.
 *
 * A worker that restarts keeps nothing; the document, which lives on,
 * reconnects and reports its runs again. A document that goes away while the
 * worker did not close it has crashed: the jobs it had not uploaded are
 * cancelled here, so none keeps holding one of today's uses.
 */
export class CaptionWorkHost {
  private readonly instance = crypto.randomUUID();
  private revision = 0;
  private runs: WorkRuns = NO_RUNS;
  private sent = JSON.stringify(NO_RUNS);
  private port: chrome.runtime.Port | null = null;
  private readonly connecting: (() => void)[] = [];
  /** Runs the connected document has reported; one it stops reporting is over. */
  private owned: { single: string | null; queue: string | null } = { single: null, queue: null };
  private unfinished: readonly string[] = [];
  private documentBusy = false;
  private lane: Promise<unknown> = Promise.resolve();
  private readonly pending = new Map<number, (outcome: CommandOutcome) => void>();
  private commandId = 0;
  private session = 0;

  constructor(private readonly options: WorkHostOptions) {}

  state(): CaptionWorkState {
    return {
      version: 1,
      type: "CAPTION_WORK_STATE",
      instance: this.instance,
      revision: this.revision,
      single: this.runs.single,
      queue: this.runs.queue,
    };
  }

  /** Only for a port whose sender passed `offscreenSender`. */
  connect(port: chrome.runtime.Port): void {
    this.port = port;
    port.onMessage.addListener((message: unknown) => this.received(port, message));
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      this.dropped(port, false);
    });
    this.post({ type: "ready" }, port);
    for (const resolve of this.connecting.splice(0)) resolve();
  }

  /** Only for a message whose sender passed `panelSender`. */
  command(command: CaptionWorkCommand): Promise<CaptionWorkReply> {
    if (command.type === "CAPTION_WORK_GET") return Promise.resolve(this.reply(null));
    const session = this.session;
    return this.enqueue(async () => {
      if (session !== this.session) return { status: "error", code: "LOGIN_REQUIRED" };
      if (command.type === "CAPTION_WORK_START" && !(await this.ensure()))
        return { status: "error", code: "UNAVAILABLE" };
      if (session !== this.session) {
        this.settle();
        return { status: "error", code: "LOGIN_REQUIRED" };
      }
      let accepted: string | null = null;
      if (this.port) {
        const outcome = await this.send(command);
        if (outcome.status === "error") {
          this.settle();
          return outcome;
        }
        accepted = outcome.accepted;
      }
      // What an earlier document left behind is the worker's alone to forget.
      accepted ??= this.forget(command);
      this.settle();
      return this.reply(accepted);
    });
  }

  /** Only for a message whose sender passed `offscreenSender`. */
  async request(
    request: OffscreenRequest,
  ): Promise<MediaReply | OpenReply | AcceptReply | TokenReply> {
    switch (request.type) {
      case "CAPTION_OFFSCREEN_MEDIA":
        return "tabId" in request ? this.media(request.tabId) : this.lectureMedia(request);
      case "CAPTION_OFFSCREEN_OPEN":
        return this.open(request.tabId, request.batch, request.index);
      case "CAPTION_OFFSCREEN_ACCEPT":
        try {
          await saveActiveJob({ jobId: request.jobId, key: request.key });
          this.options.monitor.track(request.jobId, request.key);
          return { status: "success" };
        } catch {
          return { status: "error", code: "STORAGE" };
        }
      case "CAPTION_OFFSCREEN_TOKEN":
        return this.token(request);
    }
  }

  /** The sign-in changed or local data was deleted: nothing of it is shown or continued. */
  sessionEnded(): void {
    this.session++;
    this.post({ type: "session-ended" });
    this.unfinished = [];
    this.runs = NO_RUNS;
    this.publish();
  }

  private reply(accepted: string | null): CaptionWorkReply {
    return { status: "success", state: this.state(), accepted };
  }

  private post(message: WorkPortCommand, port = this.port): void {
    try {
      port?.postMessage(message);
    } catch {
      // A closing document's port disappears; its onDisconnect handles it.
    }
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.lane.then(task, task);
    this.lane = next.catch(() => {});
    return next;
  }

  private publish(): void {
    const text = JSON.stringify(this.runs);
    if (text === this.sent) return;
    this.sent = text;
    this.revision++;
    this.options.onWork(this.runs);
    try {
      void chrome.runtime.sendMessage(this.state()).catch(() => {});
    } catch {
      // No extension page is open to receive it.
    }
  }

  private received(port: chrome.runtime.Port, raw: unknown): void {
    if (port !== this.port) return;
    const message = workPortMessage(raw);
    if (!message) return;
    switch (message.type) {
      case "alive":
        return;
      case "work":
        this.report(message);
        return;
      case "rule":
        void this.options.rules
          .add(message.id, message.mediaUrl)
          .then((ok) => this.post({ type: "rule", id: message.id, ok }, port));
        return;
      case "unrule":
        void this.options.rules
          .remove(message.id)
          .then(() => this.post({ type: "unrule", id: message.id }, port));
        return;
      case "reply": {
        const resolve = this.pending.get(message.id);
        this.pending.delete(message.id);
        resolve?.(
          message.status === "success"
            ? { status: "success", accepted: message.accepted }
            : { status: "error", code: message.code },
        );
      }
    }
  }

  private report(work: Extract<WorkPortMessage, { type: "work" }>): void {
    this.unfinished = work.unfinished;
    this.documentBusy = workBusy(work) || work.unfinished.length > 0;
    const next = <T extends { readonly run: string }>(
      kind: "single" | "queue",
      reported: T | null,
      shown: T | null,
    ): T | null => {
      if (reported) {
        this.owned[kind] = reported.run;
        return reported;
      }
      if (shown && shown.run === this.owned[kind]) {
        this.owned[kind] = null;
        return null;
      }
      // Left by an earlier document: shown until replaced or dismissed.
      return shown;
    };
    this.runs = {
      single: next("single", work.single, this.runs.single),
      queue: next("queue", work.queue, this.runs.queue),
    };
    this.publish();
    this.settle();
  }

  private dropped(port: chrome.runtime.Port, wanted: boolean): void {
    if (port !== this.port) return;
    this.port = null;
    this.owned = { single: null, queue: null };
    this.documentBusy = false;
    for (const resolve of this.pending.values())
      resolve({ status: "error", code: "UNAVAILABLE" });
    this.pending.clear();
    void this.options.rules.clear();
    const lost = this.unfinished;
    this.unfinished = [];
    if (wanted) return;
    for (const id of lost) void cancelJob(id).catch(() => safeLog("REQUEST_FAILED"));
    this.runs = interrupted(this.runs);
    this.publish();
  }

  private settle(): void {
    if (this.port && !this.documentBusy) void this.enqueue(() => this.closeIdle());
  }

  private async closeIdle(): Promise<void> {
    const port = this.port;
    if (!port || this.documentBusy) return;
    await chrome.offscreen.closeDocument().catch(() => {});
    // The port's own disconnect arrives later; the document is gone now.
    this.dropped(port, true);
  }

  private create(): Promise<void> {
    // Refused when a document exists already, as after a worker restart: its
    // port is on its way.
    return chrome.offscreen
      .createDocument({ url: OFFSCREEN_PATH, reasons: [REASON], justification: JUSTIFICATION })
      .catch(() => {});
  }

  private connected(): Promise<boolean> {
    if (this.port) return Promise.resolve(true);
    return new Promise((resolve) => {
      const waiter = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.connecting.splice(this.connecting.indexOf(waiter), 1);
        resolve(false);
      }, DOCUMENT_CONNECT_MS);
      this.connecting.push(waiter);
    });
  }

  private async ensure(): Promise<boolean> {
    if (this.port) return true;
    await this.create();
    if (await this.connected()) return true;
    // A document that never reaches the worker is of no use: replace it once.
    await chrome.offscreen.closeDocument().catch(() => {});
    await this.create();
    return this.connected();
  }

  private send(command: RunCommand): Promise<CommandOutcome> {
    const id = ++this.commandId;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ status: "error", code: "TIMEOUT" });
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(id, (outcome) => {
        clearTimeout(timer);
        resolve(outcome);
      });
      this.post({ type: "command", id, command });
    });
  }

  private forget(command: RunCommand): string | null {
    const { single, queue } = this.runs;
    let accepted: string | null = null;
    if (
      command.type === "CAPTION_WORK_CANCEL" &&
      command.kind === "single" &&
      single?.run === command.run
    ) {
      accepted = single.phase === "queued" ? single.jobId : null;
      this.runs = { single: null, queue };
    } else if (
      command.type === "CAPTION_WORK_DISMISS" &&
      queue?.run === command.run &&
      !queue.running
    )
      this.runs = { single, queue: null };
    this.publish();
    return accepted;
  }

  private async media(tabId: number): Promise<MediaReply> {
    try {
      return { status: "success", media: await lecture(await identifyMedia(tabId)) };
    } catch (error) {
      return { status: "error", code: errorCode(error) };
    }
  }

  /** The player document the lecture tab shows right now, if any. */
  private async lectureSource(source: number): Promise<MediaSource | null> {
    const saved = await savedLectureTab(source);
    return saved === null ? null : identifyMedia(saved).catch(() => null);
  }

  /**
   * A new player in the lecture tab, returned only once the list tab confirms
   * its document belongs to the lecture it opened last: the list tab alone
   * knows that lecture's address, and the document sends whatever audio it
   * gets here. The previous lecture's document is never asked about.
   */
  private async lectureMedia(
    request: Extract<OffscreenRequest, { lectureOf: number }>,
  ): Promise<MediaReply> {
    const { lectureOf: source, after, batch, index } = request;
    const found = await this.lectureSource(source).catch(() => null);
    if (!found) return { status: "pending" };
    if (found.documentId === after) return { status: "stale" };
    const verdict = await this.ask(
      source,
      { version: 1, type: "CAPTION_BATCH_VERIFY", batch, index, document: found.documentId },
      VERIFY_TIMEOUT_MS,
    );
    if (verdict && verdict !== "TIMEOUT") {
      if (verdict.status === "success") {
        try {
          return { status: "success", media: await lecture(found) };
        } catch {
          return { status: "pending" };
        }
      }
      if (LOST_SELECTION.has(verdict.code)) return { status: "error", code: verdict.code };
      if (verdict.code === "RATE_LIMITED") return { status: "unverified", code: "RATE_LIMITED" };
    }
    // No answer, or one that is not a yes, leaves the player unconfirmed.
    return { status: "unverified", code: "LECTURE_MISMATCH" };
  }

  /** The list tab's answer to a caption batch message; `null` when the
      message got no answer and `TIMEOUT` when none came in `ms`. */
  private async ask(
    tabId: number,
    query: Request,
    ms: number,
  ): Promise<Result | "TIMEOUT" | null> {
    const tab = await chrome.tabs.get(tabId).catch(() => undefined);
    if (!tab?.url || !allowedPage(tab.url)) return { status: "error", code: "RELOAD_TAB" };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
      const answer: unknown = await Promise.race([
        chrome.tabs.sendMessage(tabId, query, { frameId: 0 }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            reject(new Error("TIMEOUT"));
          }, ms);
        }),
      ]);
      return parseResult(answer, query, new URL(tab.url).origin);
    } catch {
      return timedOut ? "TIMEOUT" : null;
    } finally {
      clearTimeout(timer);
    }
  }

  private async open(tabId: number, batch: string, index: number): Promise<OpenReply> {
    // The tab may still show the last lecture until the new page commits, and
    // the user may switch it during a retry wait, so it is read per attempt.
    const previous =
      (await this.lectureSource(tabId).catch(() => null))?.documentId ?? null;
    const result = await this.ask(
      tabId,
      { version: 1, type: "CAPTION_BATCH_OPEN", batch, index },
      OPEN_TIMEOUT_MS,
    );
    if (result === "TIMEOUT") return { status: "error", code: "TIMEOUT" };
    if (!result) return { status: "error", code: "RELOAD_TAB" };
    return result.status === "success"
      ? { status: "success", previous }
      : { status: "error", code: result.code };
  }

  private async token(
    request: Extract<OffscreenRequest, { type: "CAPTION_OFFSCREEN_TOKEN" }>,
  ): Promise<TokenReply> {
    // Only the access token leaves the worker: the stored session also holds
    // the refresh token and the account's email.
    const grant = (session: AccessGrant | null): AccessGrant | null =>
      session && {
        id: session.id,
        loginId: session.loginId,
        accessToken: session.accessToken,
      };
    try {
      if (request.action === "current")
        return { status: "success", grant: grant(await storedSessionAccess.current()) };
      const used = { id: request.session, loginId: request.loginId };
      if (request.action === "refresh")
        return { status: "success", grant: grant(await storedSessionAccess.refresh(used)) };
      await storedSessionAccess.reject(used);
      return { status: "success", grant: null };
    } catch (error) {
      return { status: "error", code: errorCode(error) };
    }
  }
}
