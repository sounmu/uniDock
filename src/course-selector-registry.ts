import type { Course, InternalCourse } from "./domain";

interface SelectorEntry {
  readonly id: string;
  readonly account: string;
  readonly epoch: number;
  readonly expiresAt: number;
}

interface Issuer {
  readonly generation: number;
  selectors: Set<string>;
  completed: boolean;
  expiresAt?: number;
}

export interface CourseSelectorAdmission {
  readonly scope: string;
  readonly generation: number;
}

const MAX_ISSUERS = 64;
const MAX_SELECTORS = 40_000;
const MAX_COURSES = 10_000;
export const COURSE_SELECTOR_TTL_MS = 5 * 60_000;

/** Bounded, reusable, content-document-memory-only course capabilities. */
export class CourseSelectorRegistry {
  private readonly issuers = new Map<string, Issuer>();
  private readonly selectors = new Map<string, SelectorEntry>();
  private generation = 0;

  admit(scope: string, now = Date.now()): CourseSelectorAdmission {
    this.sweep(now);
    this.revoke(scope);
    if (this.issuers.size >= MAX_ISSUERS) throw new Error("LIMIT");
    const admission = { scope, generation: ++this.generation };
    this.issuers.set(scope, {
      generation: admission.generation,
      selectors: new Set(),
      completed: false,
    });
    return admission;
  }

  publish(
    admission: CourseSelectorAdmission,
    courses: readonly InternalCourse[],
    account: string,
    epoch: number,
    now = Date.now(),
  ): Course[] | undefined {
    const issuer = this.issuers.get(admission.scope);
    if (issuer?.generation !== admission.generation) return undefined;
    this.sweep(now);
    if (this.issuers.get(admission.scope) !== issuer) return undefined;
    if (
      courses.length > MAX_COURSES ||
      this.selectors.size + courses.length > MAX_SELECTORS
    )
      throw new Error("LIMIT");
    const expiresAt = now + COURSE_SELECTOR_TTL_MS;
    issuer.completed = true;
    issuer.expiresAt = expiresAt;
    const result = courses.map((course) => {
      const courseSelector = crypto.randomUUID();
      issuer.selectors.add(courseSelector);
      this.selectors.set(courseSelector, {
        id: course.id,
        account,
        epoch,
        expiresAt,
      });
      return { name: course.name, courseSelector };
    });
    return result;
  }

  resolve(
    selector: string,
    account: string,
    epoch: number,
    now = Date.now(),
  ): string | undefined {
    this.sweep(now);
    const entry = this.selectors.get(selector);
    if (!entry) return undefined;
    if (entry.expiresAt <= now) {
      this.removeSelector(selector);
      return undefined;
    }
    return entry.account === account && entry.epoch === epoch
      ? entry.id
      : undefined;
  }

  current(admission: CourseSelectorAdmission): boolean {
    return (
      this.issuers.get(admission.scope)?.generation === admission.generation
    );
  }

  discard(admission: CourseSelectorAdmission): void {
    const issuer = this.issuers.get(admission.scope);
    if (
      issuer?.generation === admission.generation &&
      !issuer.completed &&
      issuer.selectors.size === 0
    )
      this.issuers.delete(admission.scope);
  }

  revoke(scope: string): void {
    const issuer = this.issuers.get(scope);
    if (!issuer) return;
    for (const selector of issuer.selectors) this.selectors.delete(selector);
    this.issuers.delete(scope);
  }

  revokeAll(): void {
    this.issuers.clear();
    this.selectors.clear();
  }

  private removeSelector(selector: string): void {
    if (!this.selectors.delete(selector)) return;
    for (const issuer of this.issuers.values())
      issuer.selectors.delete(selector);
  }

  private sweep(now: number): void {
    for (const [selector, entry] of this.selectors)
      if (entry.expiresAt <= now) this.removeSelector(selector);
    for (const [scope, issuer] of this.issuers)
      if (
        issuer.completed &&
        issuer.selectors.size === 0 &&
        issuer.expiresAt !== undefined &&
        issuer.expiresAt <= now
      )
        this.issuers.delete(scope);
  }
}
