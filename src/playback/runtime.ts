import {
  planPlayback,
  type PlaybackCandidate,
  type PlaybackPlan,
  type ScheduledPlayback,
} from "./scheduler";
import { emptyPlayback, type PlaybackStore } from "./storage";
import {
  type PlaybackCommand,
  type PlaybackDiscovery,
  type PlaybackError,
  type PlaybackResult,
  type PlaybackSnapshot,
  type PlayerBinding,
  type PlayerSignal,
  type RuntimeStatus,
  type ResolvedRecording,
} from "./bridge";

export const PLAYBACK_ALARM = "unidock.playback.wake";
export const PLAYBACK_WATCHDOG = "unidock.playback.watchdog";
export const PLAYBACK_RETENTION = "unidock.playback.retention";
const TERMINAL_RETENTION = 30 * 24 * 3600000;
export interface PlayerAddress {
  readonly tabId: number;
  readonly frameId: number;
  readonly documentId: string;
}
export interface RuntimePorts {
  readonly store: PlaybackStore;
  readonly now: () => number;
  readonly uuid: () => string;
  readonly discover: () => Promise<PlaybackDiscovery>;
  readonly resolve: (handle: string) => Promise<ResolvedRecording>;
  readonly open: (url: string) => Promise<number>;
  readonly navigate: (tabId: number, url: string) => Promise<void>;
  readonly close: (tabId: number) => Promise<void>;
  readonly control: (
    address: PlayerAddress,
    binding: PlayerBinding,
    action: "pause" | "resume" | "stop",
  ) => Promise<void>;
  readonly alarm: (name: string, when: number | null) => Promise<void>;
}
export class PlaybackRuntimeError extends Error {
  constructor(readonly code: PlaybackError) {
    super(code);
  }
}
interface ActiveRun {
  item: ScheduledPlayback;
  runId: string;
  tabId: number | null;
  address: PlayerAddress | null;
  token: string;
  stopAt: number;
}
export interface PlayerAuthorization {
  readonly binding: PlayerBinding;
  readonly leaseUntil: number;
}

/** One serialized owner of durable state; urgent commands invalidate in-flight work synchronously. */
export class PlaybackRuntime {
  private saved = emptyPlayback();
  private discovery: PlaybackDiscovery | null = null;
  private plan: PlaybackPlan = { queue: [], blocked: [] };
  private status: RuntimeStatus = "idle";
  private run: ActiveRun | null = null;
  private epoch = 0;
  private lane: Promise<unknown> = Promise.resolve();
  private initialized = false;
  private consented = false;
  private calendarSources = new Map<string, string>();
  constructor(private readonly ports: RuntimePorts) {}

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.lane.then(operation, operation);
    this.lane = next;
    return next;
  }
  private snapshot(): PlaybackSnapshot {
    return {
      settings: this.saved.settings,
      courses: this.discovery?.courses ?? [],
      labels: Object.fromEntries(
        (this.discovery?.candidates ?? []).map((candidate) => [
          candidate.id,
          candidate.title || "영상 제목 확인 필요",
        ]),
      ),
      queue: this.plan.queue.filter((item) => item.id !== this.run?.item.id),
      blocked: this.plan.blocked,
      status: this.status,
      active: this.run ? { ...this.run.item, credit: "unknown" } : null,
      finishedIds: [...this.saved.finishedIds],
      confirmationRequired: this.plan.blocked.some((item) =>
        [
          "unknown_duration",
          "unknown_completion",
          "unknown_deadline",
          "date_only_deadline",
          "invalid_deadline",
        ].includes(item.reason),
      ),
      calendarOverrides: this.saved.calendarOverrides.map((override) => ({
        ...override,
        confirmationRequired:
          this.calendarSources.get(override.id) !== override.sourceRevision,
      })),
    };
  }
  private prune(): void {
    const expired = new Set(
      Object.entries(this.saved.terminalAt)
        .filter(([, at]) => at + TERMINAL_RETENTION <= this.ports.now())
        .map(([id]) => id),
    );
    this.saved.finishedIds = this.saved.finishedIds.filter(
      (id) => !expired.has(id),
    );
    this.saved.excludedIds = this.saved.excludedIds.filter(
      (id) => !expired.has(id),
    );
    this.saved.confirmations = this.saved.confirmations.filter(
      (item) => !expired.has(item.id),
    );
    this.saved.terminalAt = Object.fromEntries(
      Object.entries(this.saved.terminalAt).filter(([id]) => !expired.has(id)),
    );
  }
  private async persist(): Promise<void> {
    if (!this.saved.accountKey || !this.consented) return;
    this.prune();
    try {
      await this.ports.store.save(this.saved);
    } catch {
      throw new PlaybackRuntimeError("STORAGE");
    }
    const times = Object.values(this.saved.terminalAt);
    await this.ports.alarm(
      PLAYBACK_RETENTION,
      times.length ? Math.min(...times) + TERMINAL_RETENTION : null,
    );
  }
  private async disarm(): Promise<void> {
    await Promise.all([
      this.ports.alarm(PLAYBACK_ALARM, null),
      this.ports.alarm(PLAYBACK_WATCHDOG, null),
      this.ports.alarm(PLAYBACK_RETENTION, null),
    ]);
  }
  private async release(): Promise<void> {
    const run = this.run;
    this.run = null;
    const tabId = run?.tabId ?? this.saved.player?.tabId;
    this.saved.player = null;
    if (tabId !== undefined && tabId !== null) await this.ports.close(tabId);
    await this.ports.alarm(PLAYBACK_WATCHDOG, null);
  }
  private async fault(error: unknown): Promise<PlaybackResult> {
    this.epoch++;
    this.status =
      error instanceof PlaybackRuntimeError && error.code === "LOGIN_REQUIRED"
        ? "blocked-login"
        : "failed";
    this.saved.stopped = true;
    this.plan = { queue: [], blocked: [] };
    try {
      await this.release();
      await this.disarm();
      await this.persist();
    } catch {
      return { status: "error", code: "STORAGE" };
    }
    return {
      status: "error",
      code: error instanceof PlaybackRuntimeError ? error.code : "NETWORK",
    };
  }
  private candidates(): PlaybackCandidate[] {
    return (this.discovery?.candidates ?? []).map((item) => {
      const confirmation = this.saved.confirmations.find(
        (known) =>
          known.id === item.id &&
          known.courseId === item.courseId &&
          known.sourceDeadline === item.deadline,
      );
      return confirmation && item.completion !== "complete"
        ? {
            id: item.id,
            courseId: item.courseId,
            deadline: confirmation.deadline,
            durationMinutes: confirmation.durationMinutes,
            completion: confirmation.completion,
          }
        : item;
    });
  }
  private async refresh(
    epoch: number,
    known?: PlaybackDiscovery,
  ): Promise<boolean> {
    const discovery = known ?? (await this.ports.discover());
    if (epoch !== this.epoch) return false;
    if (
      this.saved.accountKey &&
      this.saved.accountKey !== discovery.accountKey
    ) {
      await this.release();
      await this.disarm();
      await this.ports.store.clear();
      this.consented = false;
      this.saved = emptyPlayback(discovery.accountKey, discovery.origin);
      this.discovery = discovery;
      this.calendarSources.clear();
      this.plan = { queue: [], blocked: [] };
      this.status = "idle";
      await this.persist();
      throw new PlaybackRuntimeError("ACCOUNT_CHANGED");
    }
    if (!this.saved.accountKey)
      this.saved = emptyPlayback(discovery.accountKey, discovery.origin);
    if (this.saved.origin !== discovery.origin)
      throw new PlaybackRuntimeError("POLICY");
    this.discovery = discovery;
    this.prune();
    const candidates = this.candidates().filter(
      (item) =>
        !this.saved.finishedIds.includes(item.id) &&
        !this.saved.excludedIds.includes(item.id),
    );
    this.plan = planPlayback(candidates, this.saved.settings, this.ports.now());
    await this.persist();
    return epoch === this.epoch;
  }
  private async schedule(): Promise<void> {
    if (this.run || this.saved.stopped || !this.saved.settings.enabled) {
      await this.ports.alarm(PLAYBACK_ALARM, null);
      return;
    }
    const next = this.plan.queue[0];
    this.status = next
      ? "scheduled"
      : this.snapshot().confirmationRequired
        ? "confirmation-required"
        : "idle";
    await this.ports.alarm(
      PLAYBACK_ALARM,
      next ? Math.max(this.ports.now() + 1000, next.startAt) : null,
    );
  }
  private async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    const loaded = await this.ports.store.load();
    this.consented = loaded !== null;
    this.saved = loaded ?? emptyPlayback();
    this.prune();
    // Never replay an item whose worker lost its live document authorization.
    if (this.saved.player) {
      this.saved.stopped = true;
      this.status = "paused";
      await this.release();
      await this.persist();
    }
    await this.disarm();
  }
  startup(): Promise<PlaybackResult> {
    return this.serial(async () => {
      try {
        await this.init();
        if (this.consented && (await this.refresh(this.epoch)))
          await this.schedule();
        return { status: "success", snapshot: this.snapshot() };
      } catch (error) {
        return this.fault(error);
      }
    });
  }
  command(command: PlaybackCommand): Promise<PlaybackResult> {
    const urgent =
      command.type === "PLAYBACK_STOP_ALL" ||
      command.type === "LOCAL_DATA_DELETE_ALL" ||
      (command.type === "PLAYBACK_CANCEL" &&
        command.id === this.run?.item.id) ||
      command.type === "PLAYBACK_PAUSE" ||
      command.type === "PLAYBACK_CONFIGURE";
    const wasStopped = this.saved.stopped;
    if (urgent) {
      this.epoch++;
      this.saved.stopped = true;
    }
    const epoch = this.epoch;
    // Revoke advancement immediately, even while a fresh read is in flight.
    const current = this.run;
    const terminal = urgent && command.type !== "PLAYBACK_PAUSE";
    const action =
      terminal && current?.tabId !== null && current?.tabId !== undefined
        ? this.ports.close(current.tabId).then(() => {
            if (this.run === current) {
              current.tabId = null;
              this.saved.player = null;
            }
          })
        : urgent && current?.address
          ? this.ports.control(current.address, this.binding(current), "pause")
          : Promise.resolve();
    const immediate = action.then(
      () => ({ ok: true }) as const,
      (error: unknown) => ({ ok: false, error }) as const,
    );
    return this.serial(async () => {
      try {
        const outcome = await immediate;
        if (!outcome.ok) throw outcome.error;
        await this.init();
        switch (command.type) {
          case "PLAYBACK_STATUS":
            if ((await this.refresh(epoch)) && !this.run) await this.schedule();
            return { status: "success", snapshot: this.snapshot() };
          case "LOCAL_DATA_DELETE_ALL":
            await this.release();
            await this.disarm();
            await this.ports.store.erase();
            this.consented = false;
            this.saved = emptyPlayback();
            this.discovery = null;
            this.calendarSources.clear();
            this.plan = { queue: [], blocked: [] };
            this.status = "idle";
            return { status: "success", snapshot: this.snapshot() };
          case "CALENDAR_OVERRIDES_GET":
            if (!(await this.refresh(epoch))) break;
            this.calendarSources = new Map(
              command.sources.map((source) => [
                source.id,
                source.sourceRevision,
              ]),
            );
            break;
          case "CALENDAR_OVERRIDE_SET":
            if (!(await this.refresh(epoch))) break;
            this.consented = true;
            this.saved.calendarOverrides = [
              ...this.saved.calendarOverrides.filter(
                (override) => override.id !== command.override.id,
              ),
              { ...command.override },
            ];
            this.calendarSources.set(
              command.override.id,
              command.override.sourceRevision,
            );
            break;
          case "CALENDAR_OVERRIDE_REMOVE":
            if (!(await this.refresh(epoch))) break;
            this.saved.calendarOverrides = this.saved.calendarOverrides.filter(
              (override) => override.id !== command.id,
            );
            break;
          case "PLAYBACK_CONFIRM": {
            if (!this.saved.settings.enabled)
              throw new PlaybackRuntimeError("POLICY");
            const resolved = await this.ports.resolve(command.handle);
            if (!(await this.refresh(epoch, resolved.discovery))) break;
            const candidate = resolved.discovery.candidates.find(
              (item) =>
                item.id === resolved.id && item.courseId === resolved.courseId,
            );
            if (
              !candidate ||
              candidate.completion === "complete" ||
              Date.parse(command.deadline) <= this.ports.now()
            )
              throw new PlaybackRuntimeError("STALE_SELECTION");
            this.saved.confirmations = [
              ...this.saved.confirmations.filter(
                (item) => item.id !== resolved.id,
              ),
              {
                id: resolved.id,
                courseId: resolved.courseId,
                deadline: command.deadline,
                durationMinutes: command.durationMinutes,
                completion: "incomplete",
                sourceDeadline: candidate.deadline,
              },
            ];
            this.saved.excludedIds = this.saved.excludedIds.filter(
              (id) => id !== resolved.id,
            );
            delete this.saved.terminalAt[resolved.id];
            if (await this.refresh(epoch)) await this.schedule();
            break;
          }
          case "PLAYBACK_STOP_ALL":
            for (const id of new Set([
              ...this.plan.queue.map((item) => item.id),
              ...this.saved.confirmations.map((item) => item.id),
              ...(this.run ? [this.run.item.id] : []),
            ])) {
              if (this.saved.finishedIds.includes(id)) continue;
              if (!this.saved.excludedIds.includes(id))
                this.saved.excludedIds.push(id);
              this.saved.terminalAt[id] = this.ports.now();
            }
            this.saved.stopped = true;
            this.saved.settings = { ...this.saved.settings, enabled: false };
            this.status = "stopped";
            this.plan = { queue: [], blocked: [] };
            await this.release();
            await this.disarm();
            break;
          case "PLAYBACK_PAUSE":
            this.saved.stopped = true;
            this.status = "paused";
            await this.ports.alarm(PLAYBACK_ALARM, null);
            break;
          case "PLAYBACK_CANCEL":
            this.saved.stopped = wasStopped;
            if (!this.saved.excludedIds.includes(command.id))
              this.saved.excludedIds.push(command.id);
            this.saved.terminalAt[command.id] = this.ports.now();
            if (this.run?.item.id === command.id) await this.release();
            if (await this.refresh(epoch)) await this.schedule();
            break;
          case "PLAYBACK_CONFIGURE": {
            await this.release();
            if (!(await this.refresh(epoch))) break;
            if (
              !command.settings.courseIds.every((id) =>
                this.discovery?.courses.some((course) => course.id === id),
              )
            )
              throw new PlaybackRuntimeError("POLICY");
            this.consented ||= command.settings.enabled;
            this.saved.settings = {
              ...command.settings,
              courseIds: [...command.settings.courseIds],
            };
            this.saved.stopped = !command.settings.enabled;
            if (await this.refresh(epoch)) await this.schedule();
            break;
          }
          case "PLAYBACK_REFRESH":
            if (await this.refresh(epoch)) {
              if (this.run) await this.validateRun(epoch);
              else await this.schedule();
            }
            break;
          case "PLAYBACK_RESUME":
            if (!(await this.refresh(epoch))) break;
            this.saved.stopped = false;
            if (this.run) {
              await this.validateRun(epoch);
              const run = this.run;
              if (run?.address && epoch === this.epoch) {
                await this.ports.control(
                  run.address,
                  this.binding(run),
                  "resume",
                );
                this.status = "playing";
              }
            } else await this.schedule();
            break;
        }
        await this.persist();
        return { status: "success", snapshot: this.snapshot() };
      } catch (error) {
        return this.fault(error);
      }
    });
  }
  alarm(name: string): Promise<PlaybackResult> {
    return this.serial(async () => {
      const epoch = this.epoch;
      try {
        await this.init();
        if (name === PLAYBACK_RETENTION) {
          await this.persist();
          return { status: "success", snapshot: this.snapshot() };
        }
        if (name !== PLAYBACK_ALARM && name !== PLAYBACK_WATCHDOG)
          return { status: "success", snapshot: this.snapshot() };
        if (this.saved.stopped && !this.run)
          return { status: "success", snapshot: this.snapshot() };
        if (!(await this.refresh(epoch)))
          return { status: "success", snapshot: this.snapshot() };
        if (this.run) {
          if (name === PLAYBACK_WATCHDOG)
            throw new PlaybackRuntimeError("PLAYER_LOST");
          await this.validateRun(epoch);
        } else {
          const item = this.plan.queue[0];
          if (
            item &&
            item.startAt <= this.ports.now() &&
            this.saved.settings.enabled &&
            !this.saved.stopped
          )
            await this.start(item, epoch);
          else await this.schedule();
        }
        return { status: "success", snapshot: this.snapshot() };
      } catch (error) {
        return this.fault(error);
      }
    });
  }
  private binding(run: ActiveRun): PlayerBinding {
    return {
      runId: run.runId,
      token: run.token,
      deadline: Math.min(run.item.deadline, run.stopAt),
    };
  }
  private async start(item: ScheduledPlayback, epoch: number): Promise<void> {
    const run: ActiveRun = {
      item,
      runId: this.ports.uuid(),
      token: this.ports.uuid(),
      tabId: null,
      address: null,
      stopAt:
        Math.floor((this.ports.now() + 9 * 3600000) / 86400000) * 86400000 -
        9 * 3600000 +
        this.saved.settings.windowEndHour * 3600000,
    };
    this.run = run;
    this.status = "starting";
    await this.ports.alarm(PLAYBACK_ALARM, null);
    if (epoch !== this.epoch) {
      this.run = null;
      return;
    }
    const itemId = item.id.split(":")[1];
    const url = `${this.saved.origin}/courses/${item.courseId}/modules/items/${itemId}`;
    const tabId = await this.ports.open(url);
    run.tabId = tabId;
    if (epoch !== this.epoch) {
      await this.release();
      return;
    }
    this.saved.player = { tabId, id: item.id, courseId: item.courseId };
    // Authorization is not issued until recovery information has reached durable storage.
    await this.persist();
    if (epoch !== this.epoch) {
      await this.release();
      return;
    }
    // Navigate only after the tab/run recovery record exists; fast documents cannot race authorization.
    await this.ports.navigate(tabId, url);
    await this.ports.alarm(
      PLAYBACK_WATCHDOG,
      Math.min(item.deadline, run.stopAt, this.ports.now() + 60000),
    );
  }
  private async validateRun(epoch: number): Promise<void> {
    const run = this.run;
    if (!run || epoch !== this.epoch) return;
    const candidate = this.candidates().find((item) => item.id === run.item.id);
    if (
      !candidate ||
      candidate.completion !== "incomplete" ||
      !candidate.deadline ||
      !Number.isFinite(Date.parse(candidate.deadline)) ||
      candidate.durationMinutes === null ||
      Date.parse(candidate.deadline) <= this.ports.now() ||
      run.stopAt <= this.ports.now() ||
      !this.saved.settings.courseIds.includes(candidate.courseId)
    )
      throw new PlaybackRuntimeError("STALE_SELECTION");
    run.item = {
      ...run.item,
      deadline: Math.min(run.item.deadline, Date.parse(candidate.deadline)),
    };
    if (run.item.deadline <= this.ports.now())
      throw new PlaybackRuntimeError("STALE_SELECTION");
  }
  authorize(address: PlayerAddress): Promise<PlayerAuthorization | null> {
    return this.serial(async () => {
      const epoch = this.epoch;
      try {
        const run = this.run;
        if (
          !run ||
          run.tabId !== address.tabId ||
          run.address ||
          this.saved.stopped ||
          this.status !== "starting"
        )
          return null;
        if (!(await this.refresh(epoch))) return null;
        await this.validateRun(epoch);
        if (epoch !== this.epoch || this.run !== run) return null;
        run.address = address;
        return {
          binding: this.binding(run),
          leaseUntil: Math.min(
            run.item.deadline,
            run.stopAt,
            this.ports.now() + 70000,
          ),
        };
      } catch (error) {
        await this.fault(error);
        return null;
      }
    });
  }
  private matches(address: PlayerAddress, binding: PlayerBinding): boolean {
    const run = this.run;
    return (
      !!run &&
      run.address?.tabId === address.tabId &&
      run.address.frameId === address.frameId &&
      run.address.documentId === address.documentId &&
      run.runId === binding.runId &&
      run.token === binding.token
    );
  }
  signal(
    address: PlayerAddress,
    binding: PlayerBinding,
    state: PlayerSignal,
  ): Promise<boolean> {
    const epoch = this.epoch;
    return this.serial(async () => {
      if (epoch !== this.epoch || !this.matches(address, binding)) return false;
      try {
        if (state === "ended") {
          if (this.status !== "playing" || this.saved.stopped) return false;
          const id = this.run?.item.id;
          if (id && !this.saved.finishedIds.includes(id)) {
            this.saved.finishedIds.push(id);
            this.saved.terminalAt[id] = this.ports.now();
          }
          await this.release();
          await this.persist();
          if (await this.refresh(this.epoch)) await this.schedule();
        } else if (
          state === "failed" ||
          state === "blocked-autoplay" ||
          state === "blocked-login"
        ) {
          this.saved.stopped = true;
          await this.release();
          await this.disarm();
          this.status = state;
          await this.persist();
        } else if (state === "paused") {
          this.status = "paused";
          this.saved.stopped = true;
          await this.persist();
        } else if (!this.saved.stopped) this.status = state;
        return true;
      } catch (error) {
        await this.fault(error);
        return false;
      }
    });
  }
  lease(
    address: PlayerAddress,
    binding: PlayerBinding,
  ): Promise<PlayerAuthorization | null> {
    return this.serial(async () => {
      const epoch = this.epoch;
      if (!this.matches(address, binding)) return null;
      try {
        if (!(await this.refresh(epoch))) return null;
        await this.validateRun(epoch);
        if (
          !this.matches(address, binding) ||
          epoch !== this.epoch ||
          !this.run
        )
          return null;
        await this.ports.alarm(
          PLAYBACK_WATCHDOG,
          Math.min(
            this.run.item.deadline,
            this.run.stopAt,
            this.ports.now() + 60000,
          ),
        );
        return {
          binding: this.binding(this.run),
          leaseUntil: Math.min(
            this.run.item.deadline,
            this.run.stopAt,
            this.ports.now() + 70000,
          ),
        };
      } catch (error) {
        await this.fault(error);
        return null;
      }
    });
  }
  lost(tabId: number): Promise<void> {
    if (this.run?.tabId === tabId && !this.saved.stopped) this.epoch++;
    return this.serial(async () => {
      if (this.run?.tabId === tabId) {
        if (this.saved.stopped) {
          this.run.tabId = null;
          this.saved.player = null;
          await this.release();
          await this.persist();
          return;
        }
        this.run.tabId = null;
        this.saved.player = null;
        await this.fault(new PlaybackRuntimeError("PLAYER_LOST"));
      }
    });
  }
  get dedicatedTabId(): number | null {
    return this.run?.tabId ?? null;
  }
  get dedicatedItem(): ScheduledPlayback | null {
    return this.run?.item ?? null;
  }
}
