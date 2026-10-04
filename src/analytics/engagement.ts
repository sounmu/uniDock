/** Monotonic deltas, capped gaps, and no catch-up after sleep or timer throttling. */
export class EngagementClock {
  private last: number;
  private interaction: number;
  private visible = 0;
  private active = 0;
  constructor(now: number) {
    this.last = now;
    this.interaction = now;
  }
  tick(now: number, visible: boolean, focused: boolean) {
    const delta = Math.max(0, now - this.last);
    if (delta <= 10000 && visible) {
      this.visible += delta;
      if (focused)
        this.active += Math.max(
          0,
          Math.min(now, this.interaction + 60000) - this.last,
        );
    }
    this.last = now;
  }
  interact(now: number) {
    this.interaction = now;
  }
  take() {
    const result = {
      visible_seconds: Math.floor(this.visible / 1000),
      active_seconds: Math.floor(this.active / 1000),
    };
    // Flush at most 30s; defensively clamp clock anomalies to the wire contract.
    result.visible_seconds = Math.min(60, result.visible_seconds);
    result.active_seconds = Math.min(
      result.visible_seconds,
      result.active_seconds,
    );
    this.visible %= 1000;
    this.active %= 1000;
    return result;
  }
}
