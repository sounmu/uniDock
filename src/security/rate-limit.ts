// Background defense in depth: one-use handles are enforced in the content
// script, so a compromised LMS renderer could otherwise repeat a validated
// request without bound. Worker-memory only; eviction merely resets the window.
export class TabRateLimiter {
  private readonly admitted = new Map<number, number[]>();
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}
  admit(tabId: number, now = Date.now()): boolean {
    for (const [id, times] of this.admitted) {
      const live = times.filter((time) => now - time < this.windowMs);
      if (live.length) this.admitted.set(id, live);
      else this.admitted.delete(id);
    }
    const times = this.admitted.get(tabId) ?? [];
    if (times.length >= this.limit) return false;
    times.push(now);
    this.admitted.set(tabId, times);
    return true;
  }
}
