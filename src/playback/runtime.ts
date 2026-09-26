import { emptyPlayback, type PlaybackStore } from "./storage";
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
}
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
  private lane: Promise<unknown> = Promise.resolve();
  private initialized = false;
  private consented = false;
  private epoch = 0;
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
  private async persist(): Promise<void> {
    if (!this.consented || !this.saved.accountKey) return;
    try {
      await this.ports.store.save(this.saved);
    } catch {
      throw new PlaybackRuntimeError("STORAGE");
    }
  }
  private async disarm(): Promise<void> {
    await Promise.all([
      this.ports.alarm(PLAYBACK_ALARM, null),
      this.ports.alarm(PLAYBACK_PREFLIGHT, null),
      this.ports.alarm(PLAYBACK_WATCHDOG, null),
      // Remove a possible alarm left by the non-migrated v1 scheduler.
      this.ports.alarm("unidock.playback.retention", null),
    ]);
  }
  private async release(): Promise<void> {
    const run = this.run;
    this.run = null;
    const tabId = run?.tabId ?? this.saved.player?.tabId;
    this.saved.player = null;
    await this.ports.alarm(PLAYBACK_WATCHDOG, null);
    if (tabId !== undefined && tabId !== null) await this.ports.close(tabId);
  }
  private async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    const loaded = await this.ports.store.load();
    this.consented = loaded !== null;
    this.saved = loaded ?? emptyPlayback();
    await this.disarm();
    if (this.saved.player) await this.release();
    // A worker/browser restart never starts or advances retained media.
    if (this.saved.playlist.length) {
      this.saved.stopped = true;
      this.status = "paused";
      await this.persist();
    }
  }
  private async refresh(epoch: number): Promise<boolean> {
    const discovery = await this.ports.discover();
    if (epoch !== this.epoch) return false;
    if (
      this.saved.accountKey &&
      this.saved.accountKey !== discovery.accountKey
    ) {
      await this.release();
      await this.ports.store.clear();
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
    return true;
  }
  private candidate(item: PlaylistItem): boolean {
    return !!this.discovery?.candidates.some(
      (known) => known.id === item.id && known.courseId === item.courseId,
    );
  }
  private binding(run: ActiveRun): PlayerBinding {
    // `deadline` is a short-lived authorization bound, not an LMS or playlist deadline.
    return {
      runId: run.runId,
      token: run.token,
      deadline: this.ports.now() + 70000,
    };
  }
  private async startCurrent(epoch: number): Promise<void> {
    if (this.saved.stopped || this.run) return;
    const item = this.saved.playlist[0];
    if (!item) {
      this.status = "idle";
      return;
    }
    if (!(await this.refresh(epoch))) return;
    if (!this.candidate(item))
      throw new PlaybackRuntimeError("STALE_SELECTION");
    const run: ActiveRun = {
      item,
      runId: this.ports.uuid(),
      token: this.ports.uuid(),
      tabId: null,
      address: null,
    };
    this.run = run;
    this.status = "starting";
    const itemId = item.id.split(":")[1];
    const url = `${this.saved.origin}/courses/${item.courseId}/modules/items/${itemId}`;
    const tabId = await this.ports.open(url);
    run.tabId = tabId;
    if (epoch !== this.epoch || this.run !== run) {
      await this.release();
      return;
    }
    this.saved.player = { tabId, id: item.id, courseId: item.courseId };
    await this.persist();
    if (epoch !== this.epoch || this.run !== run) {
      await this.release();
      return;
    }
    await this.ports.navigate(tabId, url);
    await this.ports.alarm(PLAYBACK_WATCHDOG, this.ports.now() + 60000);
  }
  private async blocked(error: unknown): Promise<PlaybackResult> {
    const code = error instanceof PlaybackRuntimeError ? error.code : "NETWORK";
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
  }

  startup(): Promise<PlaybackResult> {
    return this.serial(async () => {
      try {
        await this.init();
        return { status: "success", snapshot: this.snapshot() };
      } catch (error) {
        return this.blocked(error);
      }
    });
  }
  command(command: PlaybackCommand): Promise<PlaybackResult> {
    const urgent = [
      "PLAYBACK_PAUSE",
      "PLAYBACK_STOP_ALL",
      "LOCAL_DATA_DELETE_ALL",
    ].includes(command.type);
    if (urgent) {
      this.epoch++;
      this.saved.stopped = true;
    }
    const epoch = this.epoch;
    return this.serial(async () => {
      try {
        await this.init();
        switch (command.type) {
          case "PLAYBACK_STATUS":
          case "PLAYBACK_REFRESH":
            try {
              await this.refresh(epoch);
            } catch (error) {
              if (
                error instanceof PlaybackRuntimeError &&
                error.code === "LOGIN_REQUIRED" &&
                this.saved.playlist.length
              ) {
                this.epoch++;
                this.saved.stopped = true;
                this.status = "blocked-login";
                await this.release();
                await this.disarm();
                await this.persist();
                break;
              }
              throw error;
            }
            break;
          case "PLAYBACK_START": {
            const resolved: ResolvedRecording[] = [];
            for (const handle of command.handles) {
              const value = await this.ports.resolve(handle);
              if (epoch !== this.epoch) break;
              resolved.push(value);
            }
            if (epoch !== this.epoch) break;
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
            if (
              this.saved.accountKey &&
              this.saved.accountKey !== latest.accountKey
            ) {
              await this.release();
              await this.ports.store.clear();
              this.saved = emptyPlayback();
              this.discovery = latest;
              this.consented = false;
              this.status = "idle";
              throw new PlaybackRuntimeError("ACCOUNT_CHANGED");
            }
            await this.release();
            this.discovery = latest;
            this.saved = {
              ...emptyPlayback(latest.accountKey, latest.origin),
              playlist: items,
              stopped: false,
            };
            this.consented = true;
            await this.persist();
            await this.startCurrent(epoch);
            break;
          }
          case "PLAYBACK_PAUSE":
            if (this.run?.address)
              await this.ports.control(
                this.run.address,
                this.binding(this.run),
                "pause",
              );
            this.saved.stopped = true;
            this.status = "paused";
            await this.ports.alarm(PLAYBACK_WATCHDOG, null);
            break;
          case "PLAYBACK_RESUME":
            this.saved.stopped = false;
            if (this.run?.address) {
              if (
                !(await this.refresh(epoch)) ||
                !this.candidate(this.run.item)
              )
                throw new PlaybackRuntimeError("STALE_SELECTION");
              await this.ports.control(
                this.run.address,
                this.binding(this.run),
                "resume",
              );
              this.status = "playing";
              await this.ports.alarm(
                PLAYBACK_WATCHDOG,
                this.ports.now() + 60000,
              );
            } else await this.startCurrent(epoch);
            break;
          case "PLAYBACK_CANCEL": {
            const active = this.saved.playlist[0]?.id === command.id;
            this.saved.playlist = this.saved.playlist.filter(
              (item) => item.id !== command.id,
            );
            if (active) {
              await this.release();
              if (!this.saved.stopped) await this.startCurrent(epoch);
            }
            if (!this.saved.playlist.length) this.status = "idle";
            break;
          }
          case "PLAYBACK_STOP_ALL":
            await this.release();
            this.saved.playlist = [];
            this.saved.stopped = true;
            this.status = "stopped";
            await this.disarm();
            break;
          case "LOCAL_DATA_DELETE_ALL":
            await this.release();
            await this.disarm();
            await this.ports.store.erase();
            this.saved = emptyPlayback();
            this.discovery = null;
            this.consented = false;
            this.status = "idle";
            return { status: "success", snapshot: this.snapshot() };
        }
        await this.persist();
        return { status: "success", snapshot: this.snapshot() };
      } catch (error) {
        return this.blocked(error);
      }
    });
  }
  alarm(name: string): Promise<PlaybackResult> {
    return this.serial(async () => {
      try {
        await this.init();
        if (name === PLAYBACK_WATCHDOG && this.run && !this.saved.stopped)
          throw new PlaybackRuntimeError("PLAYER_LOST");
        else if (name === PLAYBACK_ALARM || name === PLAYBACK_PREFLIGHT)
          await this.ports.alarm(name, null);
        return { status: "success", snapshot: this.snapshot() };
      } catch (error) {
        return this.blocked(error);
      }
    });
  }
  authorize(address: PlayerAddress): Promise<PlayerAuthorization | null> {
    return this.serial(async () => {
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
        const epoch = this.epoch;
        if (!(await this.refresh(epoch)) || !this.candidate(run.item))
          return null;
        if (this.run !== run || epoch !== this.epoch) return null;
        run.address = address;
        return {
          binding: this.binding(run),
          leaseUntil: this.ports.now() + 60000,
        };
      } catch (error) {
        await this.blocked(error);
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
    return this.serial(async () => {
      if (!this.matches(address, binding)) return false;
      try {
        if (state === "ended") {
          if (this.status !== "playing" || this.saved.stopped) return false;
          this.saved.playlist.shift();
          await this.release();
          await this.persist();
          // Native end is the only automatic advancement trigger.
          await this.startCurrent(this.epoch);
        } else if (
          ["failed", "blocked-autoplay", "blocked-login"].includes(state)
        ) {
          this.saved.stopped = true;
          this.status = state as RuntimeStatus;
          await this.release();
          await this.disarm();
          await this.persist();
        } else if (state === "paused") {
          this.saved.stopped = true;
          this.status = "paused";
          await this.persist();
        } else if (!this.saved.stopped) this.status = state;
        return true;
      } catch (error) {
        await this.blocked(error);
        return false;
      }
    });
  }
  lease(
    address: PlayerAddress,
    binding: PlayerBinding,
  ): Promise<PlayerAuthorization | null> {
    return this.serial(async () => {
      if (!this.matches(address, binding) || this.saved.stopped || !this.run)
        return null;
      try {
        const epoch = this.epoch;
        if (
          !(await this.refresh(epoch)) ||
          !this.run ||
          !this.candidate(this.run.item)
        )
          return null;
        if (!this.matches(address, binding)) return null;
        await this.ports.alarm(PLAYBACK_WATCHDOG, this.ports.now() + 60000);
        return {
          binding: this.binding(this.run),
          leaseUntil: this.ports.now() + 60000,
        };
      } catch (error) {
        await this.blocked(error);
        return null;
      }
    });
  }
  lost(tabId: number): Promise<void> {
    if (this.run?.tabId === tabId) this.epoch++;
    return this.serial(async () => {
      if (this.run?.tabId !== tabId) return;
      this.run.tabId = null;
      this.saved.player = null;
      await this.blocked(new PlaybackRuntimeError("PLAYER_LOST"));
    });
  }
  get dedicatedTabId(): number | null {
    return this.run?.tabId ?? null;
  }
  get dedicatedItem(): PlaylistItem | null {
    return this.run?.item ?? null;
  }
}
