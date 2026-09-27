export type QueryLease = { release: () => void };

export class QueryGate {
  private active: Promise<void> | null = null;

  async acquire(): Promise<QueryLease> {
    while (this.active) await this.active;

    let finish!: () => void;
    const active = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.active = active;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        if (this.active === active) this.active = null;
        finish();
      },
    };
  }
}
