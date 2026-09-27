import {
  emptyPlayback,
  type PlaybackStore,
  type StoredPlayback,
} from "./storage";
import type { PlaylistItem } from "./playlist";
import {
  type PlaybackCommand,
  type PlaybackDiscovery,
  type PlaybackError,
  type PlaybackResult,
  type PlaybackSnapshot,
  type PlayerBinding,
  type PlayerSignal,
  type ResolvedRecording,
  type RuntimeStatus,
} from "./bridge";

// Legacy alarms are only exported so old registrations can be cleared safely.
export const PLAYBACK_ALARM = "unidock.playback.wake";
export const PLAYBACK_PREFLIGHT = "unidock.playback.preflight";
export const PLAYBACK_WATCHDOG = "unidock.playback.watchdog";

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
  readonly clearAlarmPrefix: (prefix: string) => Promise<void>;
}
export class PlaybackRuntimeError extends Error {
  constructor(readonly code: PlaybackError) {
    super(code);
  }
}
interface ActiveRun {
  item: PlaylistItem;
  runId: string;
  token: string;
  tabId: number | null;
  address: PlayerAddress | null;
  transitioning: boolean;
}
interface WatchdogArm {
  readonly name: string;
  readonly runId: string;
  readonly deadline: number;
}
interface OperationContext {
  readonly epoch: number;
  readonly intentGeneration: number | null;
}
class SupersededOperationError extends Error {}
export interface PlayerAuthorization {
  readonly binding: PlayerBinding;
  readonly leaseUntil: number;
}

/** Serialized owner of the ordered playlist and the sole player authorization issuer. */
export class PlaybackRuntime {
  private saved = emptyPlayback();
  private discovery: PlaybackDiscovery | null = null;
  private status: RuntimeStatus = "idle";
  private run: ActiveRun | null = null;
  /** State commits and immutable storage writes are ordered here; LMS reads never enter it. */
  private lane: Promise<unknown> = Promise.resolve();
  private initialization: Promise<void> | null = null;
  private consented = false;
  private epoch = 0;
  private intentGeneration = 0;
  private watchdog: WatchdogArm | null = null;
  private discoveryInFlight: {
    readonly epoch: number;
    readonly request: Promise<PlaybackDiscovery>;
  } | null = null;
  private readonly resolutions = new Map<string, Promise<ResolvedRecording>>();
  constructor(private readonly ports: RuntimePorts) {}

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.lane.then(operation, operation);
    this.lane = next;
    return next;
  }
  private snapshot(): PlaybackSnapshot {
    const current = this.run?.item ?? this.saved.playlist[0] ?? null;
    return {
      courses: this.discovery?.courses ?? [],
      labels: Object.fromEntries(
        (this.discovery?.candidates ?? []).map((item) => [
          item.id,
          item.title || "영상 제목 확인 필요",
        ]),
      ),
      current,
      queue: current
        ? this.saved.playlist.filter((item) => item.id !== current.id)
        : [...this.saved.playlist],
      status: this.status,
    };
  }
  private storedCopy(): StoredPlayback {
    return {
      ...this.saved,
      playlist: this.saved.playlist.map((item) => ({ ...item })),
      player: this.saved.player ? { ...this.saved.player } : null,
    };
  }
  private async persist(): Promise<void> {
    if (!this.consented || !this.saved.accountKey) return;
    const value = this.storedCopy();
    try {
      await this.ports.store.save(value);
    } catch {
      throw new PlaybackRuntimeError("STORAGE");
    }
  }
  private context(intentGeneration: number | null = null): OperationContext {
    return { epoch: this.epoch, intentGeneration };
  }
  private current(context: OperationContext): boolean {
    return (
      context.epoch === this.epoch &&
      (context.intentGeneration === null ||
        context.intentGeneration === this.intentGeneration)
    );
  }
  private assertCurrent(context: OperationContext): void {
    if (!this.current(context)) throw new SupersededOperationError();
  }
  private discover(epoch: number): Promise<PlaybackDiscovery> {
    if (this.discoveryInFlight?.epoch === epoch)
      return this.discoveryInFlight.request;
    const request = this.ports.discover();
    const inFlight = { epoch, request };
    this.discoveryInFlight = inFlight;
    void request
      .finally(() => {
        if (this.discoveryInFlight === inFlight) this.discoveryInFlight = null;
      })
      .catch(() => {});
    return request;
  }
  private resolve(handle: string): Promise<ResolvedRecording> {
    const known = this.resolutions.get(handle);
    if (known) return known;
    const request = this.ports.resolve(handle);
    this.resolutions.set(handle, request);
    void request
      .finally(() => {
        if (this.resolutions.get(handle) === request)
          this.resolutions.delete(handle);
      })
      .catch(() => {});
    return request;
  }
  private async disarmWatchdog(): Promise<void> {
    const watchdog = this.watchdog;
    this.watchdog = null;
    await Promise.all([
      this.ports.alarm(PLAYBACK_WATCHDOG, null),
      ...(watchdog ? [this.ports.alarm(watchdog.name, null)] : []),
    ]);
  }
  private async armWatchdog(run: ActiveRun): Promise<void> {
    const previous = this.watchdog;
    const watchdog: WatchdogArm = {
      name: `${PLAYBACK_WATCHDOG}:${this.ports.uuid()}`,
      runId: run.runId,
      deadline: this.ports.now() + 60000,
    };
    this.watchdog = watchdog;
    if (previous) await this.ports.alarm(previous.name, null);
    if (this.watchdog === watchdog)
      await this.ports.alarm(watchdog.name, watchdog.deadline);
  }
  private async disarm(): Promise<void> {
    await this.disarmWatchdog();
    await Promise.all([
      this.ports.alarm(PLAYBACK_ALARM, null),
      this.ports.alarm(PLAYBACK_PREFLIGHT, null),
      this.ports.alarm("unidock.playback.retention", null),
    ]);
  }
  /** Detach first, then start physical cleanup. Late operations can no longer own this run. */
  private release(run = this.run): Promise<void> {
    const tabId = run?.tabId ?? this.saved.player?.tabId;
    if (!run || this.run === run) {
      this.run = null;
      this.saved.player = null;
    }
    const cleanup = this.disarmWatchdog();
    const close =
      tabId === undefined || tabId === null
        ? Promise.resolve()
        : this.ports.close(tabId);
    return Promise.all([cleanup, close]).then(() => undefined);
  }
  private async abandon(run: ActiveRun): Promise<void> {
    if (this.run === run) await this.release(run);
    else if (run.tabId !== null) await this.ports.close(run.tabId);
  }
  private ensureInitialized(): Promise<void> {
    return (this.initialization ??= this.serial(async () => {
      const loaded = await this.ports.store.load();
      this.consented = loaded !== null;
      this.saved = loaded ?? emptyPlayback();
      await this.ports.clearAlarmPrefix(PLAYBACK_WATCHDOG);
      await this.disarm();
      if (this.saved.player) await this.release();
      if (this.saved.playlist.length) {
        this.saved.stopped = true;
        this.status = "paused";
        await this.persist();
      }
    }));
  }
  private commitDiscovery(
    discovery: PlaybackDiscovery,
    context: OperationContext,
  ): Promise<void> {
    return this.serial(async () => {
      this.assertCurrent(context);
      if (
        this.saved.accountKey &&
        this.saved.accountKey !== discovery.accountKey
      ) {
        await this.release();
        this.assertCurrent(context);
        await this.ports.store.clear();
        this.assertCurrent(context);
        this.saved = emptyPlayback();
        this.discovery = discovery;
        this.consented = false;
        this.status = "idle";
        throw new PlaybackRuntimeError("ACCOUNT_CHANGED");
      }
      if (!this.saved.accountKey)
        this.saved = emptyPlayback(discovery.accountKey, discovery.origin);
      if (this.saved.origin !== discovery.origin)
        throw new PlaybackRuntimeError("POLICY");
      this.discovery = discovery;
    });
  }
  private candidate(item: PlaylistItem, discovery = this.discovery): boolean {
    return !!discovery?.candidates.some(
      (known) => known.id === item.id && known.courseId === item.courseId,
    );
  }
  private binding(run: ActiveRun): PlayerBinding {
    return {
      runId: run.runId,
      token: run.token,
      deadline: this.ports.now() + 70000,
    };
  }
  private newRun(item: PlaylistItem): ActiveRun {
    return {
      item,
      runId: this.ports.uuid(),
      token: this.ports.uuid(),
      tabId: null,
      address: null,
      transitioning: false,
    };
  }
  private async launch(
    run: ActiveRun,
    context: OperationContext,
  ): Promise<void> {
    const itemId = run.item.id.split(":")[1];
    const url = `${this.saved.origin}/courses/${run.item.courseId}/modules/items/${itemId}`;
    try {
      const tabId = await this.ports.open(url);
      run.tabId = tabId;
      if (!this.current(context) || this.run !== run)
        throw new SupersededOperationError();
      await this.serial(async () => {
        this.assertCurrent(context);
        if (this.run !== run) throw new SupersededOperationError();
        this.saved.player = {
          tabId,
          id: run.item.id,
          courseId: run.item.courseId,
        };
        await this.persist();
      });
      this.assertCurrent(context);
      if (this.run !== run) throw new SupersededOperationError();
      await this.ports.navigate(tabId, url);
      this.assertCurrent(context);
      if (this.run !== run) throw new SupersededOperationError();
      await this.armWatchdog(run);
    } catch (error) {
      if (!this.current(context) || this.run !== run) {
        try {
          await this.abandon(run);
        } catch {
          // Preserve the superseded operation result after captured-tab cleanup.
        }
      }
      throw error;
    }
  }
  private async prepareAndStart(context: OperationContext): Promise<void> {
    this.assertCurrent(context);
    const item = this.saved.playlist[0];
    if (!item || this.saved.stopped || this.run) return;
    const discovery = await this.discover(context.epoch);
    this.assertCurrent(context);
    await this.commitDiscovery(discovery, context);
    this.assertCurrent(context);
    const run = await this.serial(async () => {
      this.assertCurrent(context);
      const current = this.saved.playlist[0];
      if (
        this.saved.stopped ||
        this.run ||
        current?.id !== item.id ||
        current.courseId !== item.courseId
      )
        return null;
      if (!this.candidate(item, discovery))
        throw new PlaybackRuntimeError("STALE_SELECTION");
      const created = this.newRun(item);
      this.run = created;
      this.status = "starting";
      return created;
    });
    if (run) await this.launch(run, context);
  }
  private async blocked(
    error: unknown,
    context?: OperationContext,
  ): Promise<PlaybackResult> {
    if (
      error instanceof SupersededOperationError ||
      (context && !this.current(context))
    )
      return { status: "error", code: "BUSY" };
    return this.serial(async () => {
      if (context && !this.current(context))
        return { status: "error", code: "BUSY" } as PlaybackResult;
      const code =
        error instanceof PlaybackRuntimeError ? error.code : "NETWORK";
      this.epoch++;
      this.saved.stopped = true;
      this.status = code === "LOGIN_REQUIRED" ? "blocked-login" : "failed";
      try {
        await this.release();
        await this.disarm();
        await this.persist();
      } catch {
        return { status: "error", code: "STORAGE" };
      }
      return { status: "error", code };
    });
  }
  private success(): PlaybackResult {
    return { status: "success", snapshot: this.snapshot() };
  }

  async startup(): Promise<PlaybackResult> {
    try {
      await this.ensureInitialized();
      return this.success();
    } catch (error) {
      return this.blocked(error);
    }
  }
  command(command: PlaybackCommand): Promise<PlaybackResult> {
    const urgent = [
      "PLAYBACK_PAUSE",
      "PLAYBACK_STOP_ALL",
      "LOCAL_DATA_DELETE_ALL",
    ].includes(command.type);
    const intent = ["PLAYBACK_START", "PLAYBACK_RESUME"].includes(command.type);
    if (intent) this.intentGeneration++;
    if (urgent || intent) this.epoch++;
    const context = this.context(intent ? this.intentGeneration : null);
    return this.executeCommand(command, context, urgent);
  }
  private async executeCommand(
    command: PlaybackCommand,
    context: OperationContext,
    urgent: boolean,
  ): Promise<PlaybackResult> {
    try {
      await this.ensureInitialized();
      if (command.type === "PLAYBACK_STATUS") return this.success();

      if (urgent) {
        // Mark stopped before the first cleanup await. This is deliberately not
        // queued behind a discovery/resolve/open operation.
        this.saved.stopped = true;
        const run = this.run;
        let physical: Promise<void>;
        if (
          command.type === "PLAYBACK_PAUSE" &&
          run?.address &&
          this.status === "playing" &&
          !run.transitioning
        ) {
          physical = this.ports.control(
            run.address,
            this.binding(run),
            "pause",
          );
        } else {
          physical = this.release(run);
        }
        return await this.serial(async () => {
          await physical;
          if (command.type === "PLAYBACK_PAUSE") {
            this.status = "paused";
            await this.disarmWatchdog();
          } else if (command.type === "PLAYBACK_STOP_ALL") {
            this.saved.playlist = [];
            this.status = "stopped";
            await this.disarm();
          } else {
            await this.disarm();
            await this.ports.store.erase();
            this.saved = emptyPlayback();
            this.discovery = null;
            this.consented = false;
            this.status = "idle";
            return this.success();
          }
          await this.persist();
          return this.success();
        });
      }

      this.assertCurrent(context);
      if (command.type === "PLAYBACK_REFRESH") {
        try {
          const discovery = await this.discover(context.epoch);
          this.assertCurrent(context);
          await this.commitDiscovery(discovery, context);
        } catch (error) {
          this.assertCurrent(context);
          if (
            error instanceof PlaybackRuntimeError &&
            error.code === "LOGIN_REQUIRED" &&
            this.saved.playlist.length
          ) {
            return this.serial(async () => {
              this.assertCurrent(context);
              this.epoch++;
              this.saved.stopped = true;
              this.status = "blocked-login";
              await this.release();
              await this.disarm();
              await this.persist();
              return this.success();
            });
          }
          throw error;
        }
        return this.success();
      }

      if (command.type === "PLAYBACK_START") {
        const resolved: ResolvedRecording[] = [];
        for (const handle of command.handles) {
          this.assertCurrent(context);
          resolved.push(await this.resolve(handle));
          this.assertCurrent(context);
        }
        const latest = resolved.at(-1)!.discovery;
        const items = resolved.map(({ discovery, id, courseId }) => {
          if (
            discovery.accountKey !== latest.accountKey ||
            discovery.origin !== latest.origin ||
            !latest.candidates.some(
              (candidate) =>
                candidate.id === id && candidate.courseId === courseId,
            )
          )
            throw new PlaybackRuntimeError("STALE_SELECTION");
          return { id, courseId };
        });
        if (new Set(items.map((item) => item.id)).size !== items.length)
          throw new PlaybackRuntimeError("STALE_SELECTION");
        await this.serial(async () => {
          this.assertCurrent(context);
          if (
            this.saved.accountKey &&
            this.saved.accountKey !== latest.accountKey
          ) {
            await this.release();
            this.assertCurrent(context);
            await this.ports.store.clear();
            this.assertCurrent(context);
            this.saved = emptyPlayback();
            this.discovery = latest;
            this.consented = false;
            this.status = "idle";
            throw new PlaybackRuntimeError("ACCOUNT_CHANGED");
          }
          await this.release();
          this.assertCurrent(context);
          this.discovery = latest;
          this.saved = {
            ...emptyPlayback(latest.accountKey, latest.origin),
            playlist: items,
            stopped: false,
          };
          this.consented = true;
          await this.persist();
        });
        this.assertCurrent(context);
        const run = await this.serial(async () => {
          this.assertCurrent(context);
          const created = this.newRun(items[0]!);
          this.run = created;
          this.status = "starting";
          return created;
        });
        await this.launch(run, context);
        return this.success();
      }

      if (command.type === "PLAYBACK_RESUME") {
        const captured = await this.serial(async () => {
          this.assertCurrent(context);
          if (this.run) this.run.transitioning = true;
          return this.run;
        });
        if (captured?.address) {
          const discovery = await this.discover(context.epoch);
          this.assertCurrent(context);
          if (!this.candidate(captured.item, discovery))
            throw new PlaybackRuntimeError("STALE_SELECTION");
          await this.commitDiscovery(discovery, context);
          this.assertCurrent(context);
          await this.ports.control(
            captured.address,
            this.binding(captured),
            "resume",
          );
          await this.serial(async () => {
            this.assertCurrent(context);
            if (this.run !== captured) throw new SupersededOperationError();
            captured.transitioning = false;
            this.saved.stopped = false;
            this.status = "playing";
            await this.armWatchdog(captured);
            this.assertCurrent(context);
            await this.persist();
          });
        } else {
          await this.serial(async () => {
            this.assertCurrent(context);
            this.saved.stopped = false;
          });
          await this.prepareAndStart(context);
          await this.serial(async () => {
            this.assertCurrent(context);
            await this.persist();
          });
        }
        return this.success();
      }

      if (command.type === "PLAYBACK_CANCEL") {
        await this.serial(async () => {
          this.assertCurrent(context);
          const active = this.saved.playlist[0]?.id === command.id;
          this.saved.playlist = this.saved.playlist.filter(
            (item) => item.id !== command.id,
          );
          if (active) {
            await this.release();
            this.assertCurrent(context);
          }
          if (!this.saved.playlist.length) {
            this.saved.stopped = true;
            this.status = "idle";
          }
          await this.persist();
        });
        if (!this.saved.stopped && !this.run)
          await this.prepareAndStart(context);
        return this.success();
      }
      return this.success();
    } catch (error) {
      return this.blocked(error, context);
    }
  }

  async alarm(name: string): Promise<PlaybackResult> {
    const context = this.context();
    try {
      await this.ensureInitialized();
      this.assertCurrent(context);
      const watchdog = this.watchdog;
      if (
        watchdog?.name === name &&
        this.run?.runId === watchdog.runId &&
        !this.saved.stopped &&
        (this.status === "starting" || this.status === "playing")
      )
        throw new PlaybackRuntimeError("PLAYER_LOST");
      if (name === PLAYBACK_ALARM || name === PLAYBACK_PREFLIGHT)
        await this.ports.alarm(name, null);
      return this.success();
    } catch (error) {
      return this.blocked(error, context);
    }
  }
  async authorize(address: PlayerAddress): Promise<PlayerAuthorization | null> {
    const context = this.context();
    await this.ensureInitialized();
    const run = this.run;
    if (
      !run ||
      run.tabId !== address.tabId ||
      run.address ||
      this.saved.stopped ||
      this.status !== "starting"
    )
      return null;
    try {
      const discovery = await this.discover(context.epoch);
      this.assertCurrent(context);
      if (!this.candidate(run.item, discovery)) return null;
      await this.commitDiscovery(discovery, context);
      return this.serial(async () => {
        if (!this.current(context) || this.run !== run || run.address)
          return null;
        run.address = address;
        return {
          binding: this.binding(run),
          leaseUntil: this.ports.now() + 60000,
        };
      });
    } catch (error) {
      await this.blocked(error, context);
      return null;
    }
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
  async signal(
    address: PlayerAddress,
    binding: PlayerBinding,
    state: PlayerSignal,
  ): Promise<boolean> {
    const context = this.context();
    await this.ensureInitialized();
    if (!this.matches(address, binding)) return false;
    try {
      if (state === "ended") {
        if (this.status !== "playing" || this.saved.stopped) return false;
        await this.serial(async () => {
          this.assertCurrent(context);
          if (!this.matches(address, binding))
            throw new SupersededOperationError();
          this.saved.playlist.shift();
          await this.release();
          this.assertCurrent(context);
          if (!this.saved.playlist.length) {
            this.saved.stopped = true;
            this.status = "idle";
          }
          await this.persist();
        });
        await this.prepareAndStart(context);
      } else {
        await this.serial(async () => {
          this.assertCurrent(context);
          if (!this.matches(address, binding))
            throw new SupersededOperationError();
          if (["failed", "blocked-autoplay", "blocked-login"].includes(state)) {
            this.saved.stopped = true;
            this.status = state as RuntimeStatus;
            await this.release();
            this.assertCurrent(context);
            await this.disarm();
            this.assertCurrent(context);
            await this.persist();
          } else if (state === "paused") {
            this.saved.stopped = true;
            this.status = "paused";
            await this.persist();
          } else if (!this.saved.stopped) this.status = state;
        });
      }
      return true;
    } catch (error) {
      await this.blocked(error, context);
      return false;
    }
  }
  async lease(
    address: PlayerAddress,
    binding: PlayerBinding,
  ): Promise<PlayerAuthorization | null> {
    const context = this.context();
    await this.ensureInitialized();
    const run = this.run;
    if (!run || !this.matches(address, binding) || this.saved.stopped)
      return null;
    try {
      // Every lease is based on a current in-flight/fresh discovery, never a cached result.
      const discovery = await this.discover(context.epoch);
      this.assertCurrent(context);
      if (!this.candidate(run.item, discovery)) return null;
      await this.commitDiscovery(discovery, context);
      return this.serial(async () => {
        if (
          !this.current(context) ||
          this.run !== run ||
          !this.matches(address, binding)
        )
          return null;
        await this.armWatchdog(run);
        if (
          !this.current(context) ||
          this.run !== run ||
          !this.matches(address, binding)
        )
          return null;
        return {
          binding: this.binding(run),
          leaseUntil: this.ports.now() + 60000,
        };
      });
    } catch (error) {
      await this.blocked(error, context);
      return null;
    }
  }
  async lost(tabId: number): Promise<void> {
    await this.ensureInitialized();
    if (this.run?.tabId !== tabId) return;
    this.epoch++;
    const context = this.context();
    await this.serial(async () => {
      if (this.run?.tabId !== tabId) return;
      this.run.tabId = null;
      this.saved.player = null;
    });
    await this.blocked(new PlaybackRuntimeError("PLAYER_LOST"), context);
  }
  get dedicatedTabId(): number | null {
    return this.run?.tabId ?? null;
  }
  get dedicatedItem(): PlaylistItem | null {
    return this.run?.item ?? null;
  }
}
