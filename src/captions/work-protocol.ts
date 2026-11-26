import type { AccessGrant } from "../caption-server-settings";
import { errors, validHandle, type ErrorCode } from "../protocol";
import { allowedCaptionMediaUrl } from "../security/policy";

/**
 * Messages of AI caption preparation: reading a lecture's audio and uploading
 * it. The work runs in the extension's one offscreen document, so it goes on
 * after the panel closes. Three closed exchanges:
 *
 * - panel -> worker (`CaptionWorkCommand`, `runtime.sendMessage`): start,
 *   cancel, dismiss and read the work. The worker answers with the state it
 *   also broadcasts to every panel page (`CaptionWorkState`).
 * - document -> worker (`OffscreenRequest`, `runtime.sendMessage`): the few
 *   things a document cannot do itself, since an offscreen document has no
 *   extension API but `chrome.runtime`: find a lecture's media, open the next
 *   lecture, hand over a job the server has the audio of, borrow an access
 *   token.
 * - one port the document opens to the worker (`CAPTION_WORK_PORT`): the
 *   document's runs, messages that keep the worker running, the Referer rule
 *   it needs, and the worker's commands with the document's answers. One
 *   ordered channel, so an answer never overtakes the state it describes.
 *
 * No message carries a tab URL, an LMS id or an endpoint. The media URL exists
 * only between the worker, which reads it from the player, and the document.
 * A title is a label shown back in the panel; it is never logged or sent on.
 */
export const OFFSCREEN_PATH = "offscreen.html";
export const CAPTION_WORK_PORT = "unidock-caption-work";
/** Under the 30 s service worker idle limit: a message keeps the worker running. */
export const CAPTION_WORK_ALIVE_MS = 20_000;

export const MAX_WORK_TITLE = 300;
/** As many lectures as one admitted caption batch may hold. */
export const MAX_QUEUE_ITEMS = 100;

/** Only the extension's own offscreen document. */
export function offscreenSender(sender: chrome.runtime.MessageSender): boolean {
  return (
    sender.id === chrome.runtime.id &&
    sender.tab === undefined &&
    sender.url === chrome.runtime.getURL(OFFSCREEN_PATH)
  );
}

const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

/** The closed code of a typed error; anything else is UNKNOWN. */
export function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && CODE.test(code) ? code : "UNKNOWN";
}

export class CaptionWorkError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export type PreparingPhase = "identifying" | "extracting" | "uploading";
/** `queued`: the server has the audio and the worker follows the job. */
export type SinglePhase = PreparingPhase | "queued" | "failed";
export type QueueItemPhase = "waiting" | "opening" | SinglePhase | "cancelled";

const PREPARING: readonly string[] = ["identifying", "extracting", "uploading"];
const SINGLE_PHASES: readonly string[] = [...PREPARING, "queued", "failed"];
const QUEUE_PHASES: readonly string[] = ["waiting", "opening", ...SINGLE_PHASES, "cancelled"];

export function preparingPhase(phase: string): phase is PreparingPhase {
  return PREPARING.includes(phase);
}

/** The lecture in one tab. The title is the tab's own, shown back in the panel. */
export interface SingleWork {
  readonly run: string;
  readonly tabId: number;
  readonly documentId: string | null;
  readonly phase: SinglePhase;
  readonly jobId: string | null;
  readonly key: string | null;
  readonly errorCode: string | null;
  readonly title: string;
  readonly durationS: number;
}

export interface QueueWorkItem {
  readonly handle: string;
  readonly title: string;
  readonly phase: QueueItemPhase;
  readonly errorCode: string | null;
  readonly jobId: string | null;
  readonly key: string | null;
}

/** Several lectures of one list tab, opened one after another. */
export interface QueueWork {
  /** The batch the list tab admitted. */
  readonly run: string;
  readonly tabId: number;
  readonly running: boolean;
  readonly items: readonly QueueWorkItem[];
}

export interface WorkRuns {
  readonly single: SingleWork | null;
  readonly queue: QueueWork | null;
}

export const NO_RUNS: WorkRuns = { single: null, queue: null };

/** Whether audio is being read or uploaded: one lecture at a time. */
export function workBusy(runs: WorkRuns): boolean {
  return Boolean(
    (runs.single && preparingPhase(runs.single.phase)) || runs.queue?.running,
  );
}

/** What the worker tells panel pages, in an answer or unasked on a change. */
export interface CaptionWorkState extends WorkRuns {
  readonly version: 1;
  readonly type: "CAPTION_WORK_STATE";
  /** One worker's life. */
  readonly instance: string;
  /** Counts up within an instance, so a late copy never replaces a newer one. */
  readonly revision: number;
}

export type RunCommand =
  | { version: 1; type: "CAPTION_WORK_START"; kind: "single"; run: string; tabId: number }
  | {
      version: 1;
      type: "CAPTION_WORK_START";
      kind: "queue";
      run: string;
      tabId: number;
      items: readonly { handle: string; title: string }[];
    }
  /** Stops a run and releases the job it has not uploaded yet. */
  | { version: 1; type: "CAPTION_WORK_CANCEL"; kind: "single" | "queue"; run: string }
  /** Forgets a several-lecture list that has stopped. */
  | { version: 1; type: "CAPTION_WORK_DISMISS"; run: string };

export type CaptionWorkCommand = RunCommand | { version: 1; type: "CAPTION_WORK_GET" };

/**
 * `accepted`: a cancelled single run had already handed this job to the
 * worker, so the panel that asked cancels it like any accepted job.
 */
export type CommandOutcome =
  | { status: "success"; accepted: string | null }
  | { status: "error"; code: string };

export type CaptionWorkReply =
  | { status: "success"; state: CaptionWorkState; accepted: string | null }
  | { status: "error"; code: string };

/** The player media of one lecture, with the lecture's job key instead of its LMS id. */
export interface LectureMedia {
  readonly mediaUrl: string;
  readonly durationS: number;
  readonly key: string;
  readonly title: string;
  readonly tabId: number;
  readonly documentId: string;
}

export type OffscreenRequest =
  /** The media of the lecture in this tab. */
  | { version: 1; type: "CAPTION_OFFSCREEN_MEDIA"; tabId: number }
  /** The media in the lecture tab of a list tab, once it shows a document other than `after`. */
  | { version: 1; type: "CAPTION_OFFSCREEN_MEDIA"; lectureOf: number; after: string | null }
  | { version: 1; type: "CAPTION_OFFSCREEN_OPEN"; tabId: number; batch: string; index: number }
  | { version: 1; type: "CAPTION_OFFSCREEN_ACCEPT"; jobId: string; key: string }
  | { version: 1; type: "CAPTION_OFFSCREEN_TOKEN"; action: "current" }
  | {
      version: 1;
      type: "CAPTION_OFFSCREEN_TOKEN";
      action: "refresh" | "reject";
      session: string;
      loginId: string;
    };

export type MediaReply =
  | { status: "success"; media: LectureMedia }
  | { status: "pending" }
  | { status: "error"; code: string };
/** `previous`: the document the lecture tab showed before this open. */
export type OpenReply =
  | { status: "success"; previous: string | null }
  | { status: "error"; code: ErrorCode };
export type AcceptReply = { status: "success" } | { status: "error"; code: string };
export type TokenReply =
  | { status: "success"; grant: AccessGrant | null }
  | { status: "error"; code: string };

/** Document to worker, on the port. */
export type WorkPortMessage =
  /** `unfinished`: jobs whose audio the server does not have yet. */
  | ({ type: "work"; unfinished: readonly string[] } & WorkRuns)
  | { type: "alive" }
  | { type: "rule"; id: number; mediaUrl: string }
  | { type: "unrule"; id: number }
  | ({ type: "reply"; id: number } & CommandOutcome);

/** Worker to document, on the port. */
export type WorkPortCommand =
  | { type: "ready" }
  | { type: "rule"; id: number; ok: boolean }
  | { type: "unrule"; id: number }
  | { type: "command"; id: number; command: RunCommand }
  /** The sign-in changed or local data was deleted: stop without touching jobs. */
  | { type: "session-ended" };

const JOB_ID = /^[\w-]{1,128}$/;
const JOB_KEY = /^unidock-[0-9a-f]{40}$/;
const DOCUMENT_ID = /^[\w-]{1,64}$/;
const SESSION_ID = /^[\w-]{16,64}$/;
const TOKEN = /^[\x21-\x7e]{16,4096}$/;
export const CAPTION_RULE_ID_MIN = 1_947_000;
export const CAPTION_RULE_ID_SPAN = 1000;

export const isCaptionRuleId = (id: unknown): id is number =>
  typeof id === "number" &&
  Number.isInteger(id) &&
  id >= CAPTION_RULE_ID_MIN &&
  id < CAPTION_RULE_ID_MIN + CAPTION_RULE_ID_SPAN;

type Row = Record<string, unknown>;
const row = (value: unknown): value is Row =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const size = (value: Row) => Object.keys(value).length;
const text = (value: unknown, pattern: RegExp): value is string =>
  typeof value === "string" && pattern.test(value);
const optional = (value: unknown, pattern: RegExp): value is string | null =>
  value === null || text(value, pattern);
const tab = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;
const title = (value: unknown): value is string =>
  typeof value === "string" && value.length <= MAX_WORK_TITLE;
const duration = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const counter = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

function singleWork(value: unknown): value is SingleWork {
  return (
    row(value) &&
    size(value) === 9 &&
    validHandle(value.run) &&
    tab(value.tabId) &&
    optional(value.documentId, DOCUMENT_ID) &&
    SINGLE_PHASES.includes(value.phase as string) &&
    optional(value.jobId, JOB_ID) &&
    optional(value.key, JOB_KEY) &&
    optional(value.errorCode, CODE) &&
    title(value.title) &&
    duration(value.durationS)
  );
}

function queueItem(value: unknown): value is QueueWorkItem {
  return (
    row(value) &&
    size(value) === 6 &&
    validHandle(value.handle) &&
    title(value.title) &&
    QUEUE_PHASES.includes(value.phase as string) &&
    optional(value.errorCode, CODE) &&
    optional(value.jobId, JOB_ID) &&
    optional(value.key, JOB_KEY)
  );
}

function queueWork(value: unknown): value is QueueWork {
  return (
    row(value) &&
    size(value) === 4 &&
    validHandle(value.run) &&
    tab(value.tabId) &&
    typeof value.running === "boolean" &&
    Array.isArray(value.items) &&
    value.items.length > 0 &&
    value.items.length <= MAX_QUEUE_ITEMS &&
    value.items.every(queueItem)
  );
}

const runs = (value: Row) =>
  (value.single === null || singleWork(value.single)) &&
  (value.queue === null || queueWork(value.queue));

export function isCaptionWorkState(value: unknown): value is CaptionWorkState {
  return (
    row(value) &&
    size(value) === 6 &&
    value.version === 1 &&
    value.type === "CAPTION_WORK_STATE" &&
    validHandle(value.instance) &&
    counter(value.revision) &&
    runs(value)
  );
}

function isRunCommand(value: unknown): value is RunCommand {
  if (!row(value) || value.version !== 1 || !validHandle(value.run)) return false;
  if (value.type === "CAPTION_WORK_DISMISS") return size(value) === 3;
  if (value.type === "CAPTION_WORK_CANCEL")
    return size(value) === 4 && (value.kind === "single" || value.kind === "queue");
  if (value.type !== "CAPTION_WORK_START" || !tab(value.tabId)) return false;
  if (value.kind === "single") return size(value) === 5;
  const items = value.items;
  return (
    value.kind === "queue" &&
    size(value) === 6 &&
    Array.isArray(items) &&
    items.length > 0 &&
    items.length <= MAX_QUEUE_ITEMS &&
    items.every(
      (item) => row(item) && size(item) === 2 && validHandle(item.handle) && title(item.title),
    ) &&
    new Set(items.map((item: Row) => item.handle)).size === items.length
  );
}

export function isCaptionWorkCommand(value: unknown): value is CaptionWorkCommand {
  if (row(value) && value.version === 1 && value.type === "CAPTION_WORK_GET")
    return size(value) === 2;
  return isRunCommand(value);
}

const failure = (value: Row, keys = 2): { status: "error"; code: string } | null =>
  value.status === "error" && size(value) === keys && text(value.code, CODE)
    ? { status: "error", code: value.code }
    : null;

export function captionWorkReply(value: unknown): CaptionWorkReply | null {
  if (!row(value)) return null;
  if (
    value.status === "success" &&
    size(value) === 3 &&
    isCaptionWorkState(value.state) &&
    optional(value.accepted, JOB_ID)
  )
    return { status: "success", state: value.state, accepted: value.accepted };
  return failure(value);
}

export function isOffscreenRequest(value: unknown): value is OffscreenRequest {
  if (!row(value) || value.version !== 1) return false;
  switch (value.type) {
    case "CAPTION_OFFSCREEN_MEDIA":
      if (size(value) === 3) return tab(value.tabId);
      return size(value) === 4 && tab(value.lectureOf) && optional(value.after, DOCUMENT_ID);
    case "CAPTION_OFFSCREEN_OPEN":
      return (
        size(value) === 5 &&
        tab(value.tabId) &&
        validHandle(value.batch) &&
        counter(value.index) &&
        (value.index as number) < MAX_QUEUE_ITEMS
      );
    case "CAPTION_OFFSCREEN_ACCEPT":
      return size(value) === 4 && text(value.jobId, JOB_ID) && text(value.key, JOB_KEY);
    case "CAPTION_OFFSCREEN_TOKEN":
      if (value.action === "current") return size(value) === 3;
      return (
        size(value) === 5 &&
        (value.action === "refresh" || value.action === "reject") &&
        text(value.session, SESSION_ID) &&
        text(value.loginId, SESSION_ID)
      );
    default:
      return false;
  }
}

function lectureMedia(value: unknown): value is LectureMedia {
  return (
    row(value) &&
    size(value) === 6 &&
    allowedCaptionMediaUrl(value.mediaUrl) &&
    duration(value.durationS) &&
    text(value.key, JOB_KEY) &&
    title(value.title) &&
    tab(value.tabId) &&
    text(value.documentId, DOCUMENT_ID)
  );
}

export function mediaReply(value: unknown): MediaReply | null {
  if (!row(value)) return null;
  if (value.status === "pending" && size(value) === 1) return { status: "pending" };
  if (value.status === "success" && size(value) === 2 && lectureMedia(value.media))
    return { status: "success", media: value.media };
  return failure(value);
}

export function openReply(value: unknown): OpenReply | null {
  if (!row(value) || size(value) !== 2) return null;
  if (value.status === "success" && optional(value.previous, DOCUMENT_ID))
    return { status: "success", previous: value.previous };
  return value.status === "error" && errors.includes(value.code as ErrorCode)
    ? { status: "error", code: value.code as ErrorCode }
    : null;
}

export function acceptReply(value: unknown): AcceptReply | null {
  if (!row(value)) return null;
  if (value.status === "success" && size(value) === 1) return { status: "success" };
  return failure(value);
}

function accessGrant(value: unknown): value is AccessGrant {
  return (
    row(value) &&
    size(value) === 3 &&
    text(value.id, SESSION_ID) &&
    text(value.loginId, SESSION_ID) &&
    text(value.accessToken, TOKEN)
  );
}

export function tokenReply(value: unknown): TokenReply | null {
  if (!row(value)) return null;
  if (
    value.status === "success" &&
    size(value) === 2 &&
    (value.grant === null || accessGrant(value.grant))
  )
    return { status: "success", grant: value.grant };
  return failure(value);
}

export function workPortMessage(value: unknown): WorkPortMessage | null {
  if (!row(value)) return null;
  if (value.type === "alive" && size(value) === 1) return { type: "alive" };
  if (
    value.type === "work" &&
    size(value) === 4 &&
    runs(value) &&
    Array.isArray(value.unfinished) &&
    value.unfinished.length <= MAX_QUEUE_ITEMS &&
    value.unfinished.every((id) => text(id, JOB_ID))
  )
    return {
      type: "work",
      single: value.single as SingleWork | null,
      queue: value.queue as QueueWork | null,
      unfinished: value.unfinished as string[],
    };
  if (value.type === "reply") {
    if (!counter(value.id)) return null;
    if (value.status === "success" && size(value) === 4 && optional(value.accepted, JOB_ID))
      return { type: "reply", id: value.id, status: "success", accepted: value.accepted };
    const failed = failure(value, 4);
    return failed && { type: "reply", id: value.id, ...failed };
  }
  if (!isCaptionRuleId(value.id)) return null;
  if (value.type === "unrule" && size(value) === 2) return { type: "unrule", id: value.id };
  return value.type === "rule" && size(value) === 3 && allowedCaptionMediaUrl(value.mediaUrl)
    ? { type: "rule", id: value.id, mediaUrl: value.mediaUrl }
    : null;
}

export function workPortCommand(value: unknown): WorkPortCommand | null {
  if (!row(value)) return null;
  if (value.type === "ready" && size(value) === 1) return { type: "ready" };
  if (value.type === "session-ended" && size(value) === 1) return { type: "session-ended" };
  if (value.type === "command")
    return size(value) === 3 && counter(value.id) && isRunCommand(value.command)
      ? { type: "command", id: value.id, command: value.command }
      : null;
  if (!isCaptionRuleId(value.id)) return null;
  if (value.type === "unrule" && size(value) === 2) return { type: "unrule", id: value.id };
  return value.type === "rule" && size(value) === 3 && typeof value.ok === "boolean"
    ? { type: "rule", id: value.id, ok: value.ok }
    : null;
}
