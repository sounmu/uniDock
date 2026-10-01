import {
  ANALYTICS_KEY,
  isAnalyticsCommand,
  isInstallId,
  record,
  type AnalyticsCommand,
  type AnalyticsStatus,
} from "./contract";
import { AnalyticsSink } from "./posthog";

export class AnalyticsRuntime {
  private lane: Promise<unknown> = Promise.resolve();
  private sink?: AnalyticsSink;
  private generation = 0;
  private blocked = false;
  private inFlight = 0;
  private windowStart = 0;
  private sent = 0;
  constructor(
    private readonly key: string,
    private readonly version: string,
  ) {}
  private get available() {
    return /^phc_[A-Za-z0-9_-]{10,200}$/.test(this.key);
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.lane.then(work, work);
    this.lane = next.catch(() => {});
    return next;
  }
  private stop() {
    this.generation++;
    this.blocked = true;
    this.sink?.stop();
    this.sink = undefined;
  }
  private async status(): Promise<AnalyticsStatus> {
    const stored: unknown = (await chrome.storage.local.get(ANALYTICS_KEY))[
      ANALYTICS_KEY
    ];
    if (record(stored) && stored.version === 1) {
      if (
        stored.enabled === true &&
        Object.keys(stored).length === 3 &&
        isInstallId(stored.id) &&
        this.available
      )
        return { available: true, choice: "enabled", consentId: stored.id };
      if (stored.enabled === false && Object.keys(stored).length === 2)
        return { available: this.available, choice: "disabled" };
    }
    return { available: this.available, choice: "undecided" };
  }
  /** Called before playback deletion, including when playback deletion later fails. */
  erase(): Promise<void> {
    this.stop();
    return this.serial(() => chrome.storage.local.remove(ANALYTICS_KEY));
  }
  async command(
    command: AnalyticsCommand,
  ): Promise<AnalyticsStatus | { ok: boolean }> {
    if (!isAnalyticsCommand(command)) return { ok: false };
    if (command.type === "ANALYTICS_STATUS")
      return this.serial(() => this.status());
    if (command.type === "ANALYTICS_CONSENT") {
      // Revocation aborts network requests without waiting behind storage/network work.
      this.stop();
      const generation = this.generation;
      return this.serial(async () => {
        if (command.enabled && !this.available) return this.status();
        // Two open panels can confirm the same setting. Preserve install continuity.
        if (command.enabled) {
          const current = await this.status();
          if (current.choice === "enabled") {
            if (generation === this.generation) this.blocked = false;
            return current;
          }
        }
        await chrome.storage.local.setAccessLevel({
          accessLevel: "TRUSTED_CONTEXTS",
        });
        await chrome.storage.local.set({
          [ANALYTICS_KEY]: command.enabled
            ? { version: 1, enabled: true, id: crypto.randomUUID() }
            : { version: 1, enabled: false },
        });
        if (generation === this.generation) this.blocked = !command.enabled;
        return this.status();
      });
    }
    const generation = this.generation;
    const authorized = await this.serial(async () => {
      const state = await this.status();
      return (
        !this.blocked &&
        generation === this.generation &&
        state.choice === "enabled" &&
        state.consentId === command.consentId
      );
    });
    if (!authorized || generation !== this.generation) return { ok: false };
    const now = Date.now();
    if (now - this.windowStart >= 60000) {
      this.windowStart = now;
      this.sent = 0;
    }
    if (this.sent >= 120 || this.inFlight >= 4) return { ok: false };
    this.sent++;
    this.inFlight++;
    try {
      this.sink ??= new AnalyticsSink(this.key);
      await this.sink.send(command.consentId, this.version, command.data);
      return { ok: true };
    } finally {
      this.inFlight--;
    }
  }
}
