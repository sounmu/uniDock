import {
  ANALYTICS_SETTINGS_KEY,
  ANALYTICS_STATE_KEY,
  LEGACY_ANALYTICS_KEY,
  isAnalyticsCommand,
  isAnalyticsSettings,
  record,
  type AnalyticsCommand,
  type AnalyticsSettings,
  type AnalyticsSignal,
  type AnalyticsStatus,
} from "./contract";
import {
  MAX_COUNT,
  REPORT_MAX_AGE_DAYS,
  REPORT_SCHEMA,
  SERVICES,
  addDays,
  emptyCounters,
  emptyOperation,
  isDailyCounters,
  isDailyReport,
  isEmptyCounters,
  isSeoulDate,
  latencyBucket,
  reportRows,
  seoulDate,
  type DailyCounters,
  type DailyReport,
  type Service,
} from "./report";

export const SEAL_INTERVAL_MS = 10 * 60_000;
export const FIRST_SEAL_DELAY_MS = 60_000;
export const MAX_QUEUE = 30;
export const MAX_ATTEMPTS = 12;
const BASE_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 6 * 3_600_000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_SIGNALS_PER_MINUTE = 600;

type Delivery = "pending" | "unknown" | "confirmed";
interface DayFlags {
  date: string;
  active: Delivery | null;
  core: Delivery | null;
  services: Partial<Record<Service, Delivery>>;
  /** An erased, unacknowledged denominator cannot support new install counts. */
  blocked: boolean;
}
interface PendingDelta {
  date: string;
  version: string;
  counters: DailyCounters;
}
interface QueuedReport {
  id: string;
  date: string;
  /** Exact bytes resent on every attempt. */
  body: string;
  attempts: number;
  next_attempt_at: number;
}
interface AnalyticsState {
  version: 2;
  day: DayFlags | null;
  pending: PendingDelta[];
  queue: QueuedReport[];
  last_seal_at: number;
}
export interface AnalyticsDeps {
  now(): number;
  fetch(input: string, init: RequestInit): Promise<Response>;
  uuid(): string;
  /** Wakes a stopped worker (chrome.alarms); timers alone die with the worker. */
  alarm?: { set(when: number): Promise<void>; clear(): Promise<void> };
}

const VERSION = /^\d{1,4}(?:\.\d{1,5}){1,3}$/;
function emptyState(): AnalyticsState {
  return { version: 2, day: null, pending: [], queue: [], last_seal_at: 0 };
}
function delivery(value: unknown): value is Delivery {
  return value === "pending" || value === "unknown" || value === "confirmed";
}
function parseDay(value: unknown, legacy: boolean): DayFlags | null {
  if (!record(value) || !isSeoulDate(value.date)) return null;
  if (legacy) {
    if (
      typeof value.active !== "boolean" ||
      typeof value.core !== "boolean" ||
      !Array.isArray(value.services) ||
      !value.services.every((service) =>
        (SERVICES as readonly unknown[]).includes(service),
      )
    )
      return null;
    // v1 recorded use, not delivery. A queued first attempt may have reached
    // the collector even with attempts=0, so only pending deltas prove unsent.
    const services: DayFlags["services"] = {};
    for (const service of SERVICES)
      if (value.services.includes(service)) services[service] = "unknown";
    return {
      date: value.date,
      active: value.active ? "unknown" : null,
      core: value.core ? "unknown" : null,
      services,
      blocked: value.active,
    };
  }
  if (
    (value.active !== null && !delivery(value.active)) ||
    (value.core !== null && !delivery(value.core)) ||
    typeof value.blocked !== "boolean" ||
    !record(value.services) ||
    !Object.entries(value.services).every(
      ([service, status]) =>
        (SERVICES as readonly string[]).includes(service) && delivery(status),
    )
  )
    return null;
  const services: DayFlags["services"] = {};
  for (const service of SERVICES) {
    const status = value.services[service];
    if (delivery(status)) services[service] = status;
  }
  return {
    date: value.date,
    active: value.active,
    core: value.core,
    services,
    blocked: value.blocked,
  };
}
/** Tracks only bounded daily flags, never report IDs or discarded payloads. */
function markDelivery(
  day: DayFlags,
  counters: DailyCounters,
  status: Delivery,
) {
  if (counters.active_installs && day.active !== "confirmed") {
    day.active = status;
    day.blocked = false;
  }
  if (counters.core_installs && day.core !== "confirmed") day.core = status;
  for (const service of SERVICES)
    if (
      counters.service_installs[service] &&
      day.services[service] !== "confirmed"
    )
      day.services[service] = status;
}
function discardUnsent(state: AnalyticsState): AnalyticsState {
  const day = state.day;
  if (day) {
    if (day.active === "pending") day.active = null;
    if (day.core === "pending") day.core = null;
    for (const service of SERVICES)
      if (day.services[service] === "pending") delete day.services[service];
    // Do not invent a second denominator after an ambiguous send; equally,
    // do not emit new numerators whose denominator may never have arrived.
    day.blocked = day.active === "unknown";
  }
  return { ...emptyState(), day };
}
function parseQueued(value: unknown): QueuedReport | null {
  if (
    !record(value) ||
    typeof value.body !== "string" ||
    !Number.isInteger(value.attempts) ||
    !Number.isFinite(value.next_attempt_at)
  )
    return null;
  let report: unknown;
  try {
    report = JSON.parse(value.body);
  } catch {
    return null;
  }
  if (
    !isDailyReport(report) ||
    report.report_id !== value.id ||
    report.date !== value.date
  )
    return null;
  return {
    id: report.report_id,
    date: report.date,
    body: value.body,
    attempts: value.attempts as number,
    next_attempt_at: value.next_attempt_at as number,
  };
}
/** Any malformed part is dropped rather than trusted or repaired. */
export function parseState(value: unknown): AnalyticsState {
  if (!record(value) || (value.version !== 1 && value.version !== 2))
    return emptyState();
  const pending = Array.isArray(value.pending)
    ? value.pending.filter(
        (entry): entry is PendingDelta =>
          record(entry) &&
          isSeoulDate(entry.date) &&
          typeof entry.version === "string" &&
          VERSION.test(entry.version) &&
          isDailyCounters(entry.counters),
      )
    : [];
  const queue = Array.isArray(value.queue)
    ? value.queue
        .map(parseQueued)
        .filter((entry): entry is QueuedReport => entry !== null)
        .slice(0, MAX_QUEUE)
    : [];
  const day = parseDay(value.day, value.version === 1);
  if (day && value.version === 1)
    for (const entry of pending)
      if (entry.date === day.date) markDelivery(day, entry.counters, "pending");
  return {
    version: 2,
    day,
    pending,
    queue,
    last_seal_at: Number.isFinite(value.last_seal_at)
      ? (value.last_seal_at as number)
      : 0,
  };
}
function nearCap(counters: DailyCounters): boolean {
  return reportRows(counters).some(
    (row) => row.metric !== "op_duration_ms_sum" && row.value >= MAX_COUNT - 1,
  );
}
function bump<K extends string>(map: Partial<Record<K, number>>, key: K) {
  map[key] = (map[key] ?? 0) + 1;
}

/**
 * The single writer for aggregate statistics. Every read-modify-write of the
 * settings, day flags, pending deltas and report queue runs on one serial
 * lane, so captures from several panels, sealing and send results never
 * interleave. Network I/O runs outside the lane.
 */
export class AnalyticsRuntime {
  private lane: Promise<unknown> = Promise.resolve();
  private generation = 0;
  private sending = false;
  private readonly requests = new Set<AbortController>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private scheduledAt = Number.POSITIVE_INFINITY;
  private freshInstall = false;
  private windowStart = 0;
  private signals = 0;
  private readonly deps: AnalyticsDeps;
  constructor(
    private readonly endpoint: string,
    private readonly version: string,
    deps: Partial<AnalyticsDeps> = {},
  ) {
    this.deps = {
      now: () => Date.now(),
      fetch: (input, init) => globalThis.fetch(input, init),
      uuid: () => crypto.randomUUID(),
      ...deps,
    };
  }
  get available(): boolean {
    return /^https:\/\/[a-z0-9.-]+(?::\d{1,5})?$/.test(this.endpoint);
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.lane.then(work, work);
    this.lane = next.catch(() => {});
    return next;
  }
  private stop() {
    this.generation++;
    for (const request of this.requests) request.abort();
    this.requests.clear();
    clearTimeout(this.timer);
    this.timer = undefined;
    this.scheduledAt = Number.POSITIVE_INFINITY;
    void this.deps.alarm?.clear().catch(() => {});
  }
  private async writeSettings(settings: AnalyticsSettings) {
    await chrome.storage.local.setAccessLevel?.({
      accessLevel: "TRUSTED_CONTEXTS",
    });
    await chrome.storage.local.set({ [ANALYTICS_SETTINGS_KEY]: settings });
  }
  /** Reads settings, migrating PostHog-era consent once and dropping its UUID. */
  private async settings(): Promise<AnalyticsSettings> {
    const stored = await chrome.storage.local.get([
      ANALYTICS_SETTINGS_KEY,
      LEGACY_ANALYTICS_KEY,
    ]);
    const current: unknown = stored[ANALYTICS_SETTINGS_KEY];
    const legacy: unknown = stored[LEGACY_ANALYTICS_KEY];
    if (isAnalyticsSettings(current)) {
      if (legacy !== undefined)
        await chrome.storage.local.remove(LEGACY_ANALYTICS_KEY);
      return current;
    }
    const declined =
      record(legacy) &&
      legacy.version === 1 &&
      legacy.enabled === false &&
      Object.keys(legacy).length === 2;
    const next: AnalyticsSettings = declined
      ? { version: 2, enabled: false, notice: null }
      : {
          version: 2,
          enabled: true,
          notice:
            this.freshInstall && legacy === undefined ? "first_run" : "changed",
        };
    await this.writeSettings(next);
    if (legacy !== undefined)
      await chrome.storage.local.remove(LEGACY_ANALYTICS_KEY);
    return next;
  }
  /**
   * Read-only gate for capture and sending. It never materializes a default,
   * so a worker boot that runs before onInstalled cannot misclassify a fresh
   * install; until settings exist nothing is collected.
   */
  private async collecting(): Promise<boolean> {
    const stored: unknown = (
      await chrome.storage.local.get(ANALYTICS_SETTINGS_KEY)
    )[ANALYTICS_SETTINGS_KEY];
    return (
      this.available &&
      isAnalyticsSettings(stored) &&
      stored.enabled &&
      stored.notice === null
    );
  }
  private async status(): Promise<AnalyticsStatus> {
    const settings = await this.settings();
    return {
      available: this.available,
      enabled: settings.enabled,
      notice: settings.notice,
    };
  }
  private async loadState(): Promise<AnalyticsState> {
    return parseState(
      (await chrome.storage.local.get(ANALYTICS_STATE_KEY))[
        ANALYTICS_STATE_KEY
      ],
    );
  }
  private async saveState(state: AnalyticsState) {
    await chrome.storage.local.set({ [ANALYTICS_STATE_KEY]: state });
  }
  /** Drops data the collector would reject as expired; returns whether anything changed. */
  private prune(state: AnalyticsState, now: number): boolean {
    const oldest = addDays(seoulDate(now), -REPORT_MAX_AGE_DAYS);
    const pending = state.pending.filter((entry) => entry.date >= oldest);
    const queue = state.queue.filter((entry) => entry.date >= oldest);
    const changed =
      pending.length !== state.pending.length ||
      queue.length !== state.queue.length;
    state.pending = pending;
    state.queue = queue;
    return changed;
  }
  /** Moves pending deltas into immutable queued reports in the same write. */
  private seal(state: AnalyticsState, now: number, only?: PendingDelta) {
    const keep: PendingDelta[] = [];
    for (const entry of state.pending) {
      if (
        (only && entry !== only) ||
        isEmptyCounters(entry.counters) ||
        state.queue.length >= MAX_QUEUE
      ) {
        if (!isEmptyCounters(entry.counters)) keep.push(entry);
        continue;
      }
      const report: DailyReport = {
        schema: REPORT_SCHEMA,
        report_id: this.deps.uuid(),
        date: entry.date,
        extension_version: entry.version,
        ...entry.counters,
      };
      state.queue.push({
        id: report.report_id,
        date: report.date,
        body: JSON.stringify(report),
        attempts: 0,
        next_attempt_at: 0,
      });
    }
    state.pending = keep;
    if (!only) state.last_seal_at = now;
  }
  private apply(state: AnalyticsState, signal: AnalyticsSignal, now: number) {
    const date = seoulDate(now);
    if (state.day?.date !== date)
      state.day = {
        date,
        active: null,
        core: null,
        services: {},
        blocked: false,
      };
    const day = state.day;
    let entry = state.pending.find(
      (pending) => pending.date === date && pending.version === this.version,
    );
    if (entry && nearCap(entry.counters)) {
      this.seal(state, now, entry);
      if (state.pending.includes(entry)) return false;
      entry = undefined;
    }
    if (!entry) {
      entry = { date, version: this.version, counters: emptyCounters() };
      state.pending.push(entry);
    }
    const counters = entry.counters;
    const markActive = () => {
      if (day.active) return;
      day.active = "pending";
      counters.active_installs = 1;
    };
    switch (signal.kind) {
      case "service":
        markActive();
        bump(counters.service_entries, signal.service);
        if (!day.blocked && !day.services[signal.service]) {
          day.services[signal.service] = "pending";
          counters.service_installs[signal.service] = 1;
        }
        return true;
      case "core":
        // A core result is foreground use, so it never outnumbers active installs.
        markActive();
        bump(counters.core_results, signal.result);
        if (!day.blocked && !day.core) {
          day.core = "pending";
          counters.core_installs = 1;
        }
        return true;
      case "op_start":
      case "op_end": {
        const byTrigger = (counters.operations[signal.operation] ??= {});
        const op = (byTrigger[signal.trigger] ??= emptyOperation());
        if (signal.kind === "op_start") {
          op.started++;
          return true;
        }
        switch (signal.outcome) {
          case "success":
            op.success++;
            op.duration_count++;
            op.duration_ms_sum += signal.duration_ms;
            bump(op.buckets, latencyBucket(signal.duration_ms));
            break;
          case "failure":
            op.failure++;
            bump(op.errors, signal.error);
            break;
          case "timeout":
            op.timeout++;
            bump(op.errors, "TIMEOUT");
            break;
          case "cancel":
            op.cancel++;
            break;
        }
        return true;
      }
    }
  }
  private schedule(when: number) {
    if (when >= this.scheduledAt) return;
    this.scheduledAt = when;
    clearTimeout(this.timer);
    this.timer = setTimeout(
      () => {
        this.scheduledAt = Number.POSITIVE_INFINITY;
        void this.wake();
      },
      Math.max(0, when - this.deps.now()),
    );
    void this.deps.alarm?.set(when).catch(() => {});
  }
  private nextWake(state: AnalyticsState, now: number): number {
    let next = Number.POSITIVE_INFINITY;
    if (state.pending.length)
      next = Math.max(
        now + FIRST_SEAL_DELAY_MS,
        state.last_seal_at + SEAL_INTERVAL_MS,
      );
    for (const entry of state.queue)
      next = Math.min(next, Math.max(now, entry.next_attempt_at));
    return next;
  }
  async wake(): Promise<void> {
    try {
      await this.flush();
    } catch {
      // Storage is unavailable; the next wake retries from durable state.
    }
  }
  private async flush(): Promise<void> {
    const generation = this.generation;
    const ready = await this.serial(async () => {
      if (!(await this.collecting())) return false;
      const state = await this.loadState();
      const now = this.deps.now();
      const today = seoulDate(now);
      let changed = this.prune(state, now);
      if (
        state.pending.some(
          (entry) => entry.date !== today || entry.version !== this.version,
        ) ||
        (state.pending.length && now - state.last_seal_at >= SEAL_INTERVAL_MS)
      ) {
        this.seal(state, now);
        changed = true;
      }
      if (changed) await this.saveState(state);
      return true;
    });
    if (!ready || generation !== this.generation) return;
    await this.sendDue();
    if (generation !== this.generation) return;
    await this.serial(async () => {
      const state = await this.loadState();
      const now = this.deps.now();
      const next = this.nextWake(state, now);
      if (Number.isFinite(next)) this.schedule(next);
    });
  }
  private async post(body: string): Promise<"done" | "drop" | "retry"> {
    const controller = new AbortController();
    this.requests.add(controller);
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await this.deps.fetch(`${this.endpoint}/v1/reports`, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=UTF-8" },
        body,
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      });
      // Acknowledgements carry no configuration; never read or log them.
      await response.body?.cancel().catch(() => {});
      if (response.ok) return "done";
      if ([400, 413, 422].includes(response.status)) return "drop";
      return "retry";
    } catch {
      return "retry";
    } finally {
      clearTimeout(timer);
      this.requests.delete(controller);
    }
  }
  private async sendDue() {
    if (this.sending) return;
    this.sending = true;
    try {
      for (;;) {
        const generation = this.generation;
        const item = await this.serial(async () => {
          if (!(await this.collecting())) return undefined;
          const now = this.deps.now();
          const state = await this.loadState();
          const entry = state.queue.find(
            (entry) => entry.next_attempt_at <= now,
          );
          if (entry && state.day?.date === entry.date) {
            // Persist before fetch: suspension/crash or OFF may prevent us from
            // recording the response, but the server may already have accepted.
            const report: unknown = JSON.parse(entry.body);
            if (isDailyReport(report))
              markDelivery(state.day, report, "unknown");
            await this.saveState(state);
          }
          return entry;
        });
        if (!item || generation !== this.generation) return;
        const outcome = await this.post(item.body);
        if (generation !== this.generation) return;
        await this.serial(async () => {
          const state = await this.loadState();
          const index = state.queue.findIndex((entry) => entry.id === item.id);
          if (index < 0) return;
          const entry = state.queue[index]!;
          if (outcome === "done" && state.day?.date === entry.date) {
            const report: unknown = JSON.parse(entry.body);
            if (isDailyReport(report))
              markDelivery(state.day, report, "confirmed");
          }
          entry.attempts++;
          if (outcome !== "retry" || entry.attempts >= MAX_ATTEMPTS)
            state.queue.splice(index, 1);
          else
            entry.next_attempt_at =
              this.deps.now() +
              Math.min(
                MAX_BACKOFF_MS,
                BASE_BACKOFF_MS * 2 ** (entry.attempts - 1),
              );
          await this.saveState(state);
        });
        if (outcome === "retry") return;
      }
    } finally {
      this.sending = false;
    }
  }
  installed(reason: string): Promise<void> {
    if (reason === "install") this.freshInstall = true;
    return this.serial(async () => {
      await this.settings();
    });
  }
  /**
   * Clear-data: discards unsent deltas and reports, but keeps the on/off
   * choice and confirmed/uncertain daily flags. Flags belonging only to
   * discarded, never-attempted data can be collected again after resuming.
   */
  erase<T>(clear: () => Promise<T>): Promise<T> {
    this.stop();
    return this.serial(async () => {
      const stored = await chrome.storage.local.get([
        ANALYTICS_SETTINGS_KEY,
        ANALYTICS_STATE_KEY,
      ]);
      const settings: unknown = stored[ANALYTICS_SETTINGS_KEY];
      const retained = discardUnsent(parseState(stored[ANALYTICS_STATE_KEY]));
      await chrome.storage.local.remove([
        ANALYTICS_SETTINGS_KEY,
        ANALYTICS_STATE_KEY,
        LEGACY_ANALYTICS_KEY,
      ]);
      try {
        return await clear();
      } finally {
        if (isAnalyticsSettings(settings)) await this.writeSettings(settings);
        if (retained.day) await this.saveState(retained);
      }
    });
  }
  async command(
    command: AnalyticsCommand,
  ): Promise<AnalyticsStatus | { ok: boolean }> {
    if (!isAnalyticsCommand(command)) return { ok: false };
    switch (command.type) {
      case "ANALYTICS_STATUS":
        return this.serial(() => this.status());
      case "ANALYTICS_SET": {
        // Turning off aborts in-flight sends without waiting behind the lane.
        if (!command.enabled) this.stop();
        const result = await this.serial(async () => {
          const before = await this.settings();
          await this.writeSettings({
            version: 2,
            enabled: command.enabled,
            notice: null,
          });
          if (!command.enabled) {
            const state = await this.loadState();
            await this.saveState(discardUnsent(state));
          }
          return { before, status: await this.status() };
        });
        if (command.enabled && !result.before.enabled) void this.wake();
        return result.status;
      }
      case "ANALYTICS_NOTICE_SHOWN":
        return this.serial(async () => {
          const settings = await this.settings();
          if (settings.notice)
            await this.writeSettings({ ...settings, notice: null });
          return this.status();
        });
      case "ANALYTICS_SIGNAL": {
        const now = this.deps.now();
        if (now - this.windowStart >= 60_000) {
          this.windowStart = now;
          this.signals = 0;
        }
        if (++this.signals > MAX_SIGNALS_PER_MINUTE) return { ok: false };
        return this.serial(async () => {
          if (!(await this.collecting())) return { ok: false };
          const state = await this.loadState();
          const at = this.deps.now();
          this.prune(state, at);
          const ok = this.apply(state, command.signal, at);
          await this.saveState(state);
          const next = this.nextWake(state, at);
          if (Number.isFinite(next)) this.schedule(next);
          return { ok };
        });
      }
    }
  }
}
