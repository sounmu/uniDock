/**
 * Validator store for repeat Canvas list reads (modules, module items,
 * discussion topics). It never answers a request by itself: every read still
 * goes to the server with `If-None-Match`, and a stored body is reused only
 * when the server replies 304. Authorization, revocation and availability are
 * therefore decided by the server on every call, and all capability
 * projection still runs on the (possibly reused) JSON.
 *
 * Safety rules:
 * - Only terminal single pages shorter than a full page are stored: a 304 may
 *   omit or change `Link`, and such a page cannot have grown a next page
 *   without its body (and ETag) changing.
 * - Only a single, syntactically valid entity tag (optional `W/` prefix,
 *   quoted opaque tag) is stored and sent as `If-None-Match`; `*` and tag
 *   lists are not representation-specific and are never sent.
 * - Responses marked `Cache-Control: no-store`, or varying on anything but
 *   headers this client sends constantly, are never stored; a 304 carrying
 *   such headers, or a different ETag, drops the stored page and refetches.
 * - Cross-account: a call stages its pages in its own scope and they enter the
 *   shared store only at `commit()`, which the caller invokes after it has
 *   re-confirmed the account and lifecycle epoch once the whole call finished.
 *   Pages fetched under an identity that switched mid-request are therefore
 *   never stored, and `clear()` (refresh, account change, page lifecycle)
 *   invalidates every scope handed out before it, staged or not.
 */
export interface StoredRead {
  readonly etag: string;
  readonly raw: unknown;
  readonly bytes: number;
}

export interface ConditionalReadScope {
  get(url: string): StoredRead | undefined;
  set(url: string, read: StoredRead): void;
  delete(url: string): void;
  commit(): void;
}

const MAX_ENTRIES = 64;
const MAX_BYTES = 8_000_000;
// Request headers this client sends are constant per origin, so a response
// varying only on them cannot differ between a stored page and a new request.
const CONSTANT_VARY = new Set(["accept", "accept-encoding", "origin"]);

// RFC 9110 entity-tag: ["W/"] DQUOTE *etagc DQUOTE, etagc = %x21 / %x23-7E / obs-text
const ENTITY_TAG = /^(?:W\/)?"[\x21\x23-\x7e\x80-\xff]{0,512}"$/;

export const validEntityTag = (value: string): boolean =>
  ENTITY_TAG.test(value);

const tokens = (value: string | null): string[] =>
  (value ?? "")
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);

/** Whether a response may be stored or, on a 304, still be relied on. */
export function cacheableHeaders(headers: Headers): boolean {
  if (
    tokens(headers.get("cache-control")).some(
      (token) => token === "no-store" || token.startsWith("no-store="),
    )
  )
    return false;
  return tokens(headers.get("vary")).every((token) => CONSTANT_VARY.has(token));
}

/** A 304 may repeat the validator; a different one means the page changed. */
export function sameValidator(headers: Headers, etag: string): boolean {
  const sent = headers.get("etag");
  return sent === null || sent === etag;
}

export class ConditionalReads {
  private entries = new Map<string, StoredRead>();
  private bytes = 0;
  private generation = 0;

  scope(): ConditionalReadScope {
    const generation = this.generation;
    const staged = new Map<string, StoredRead>();
    let stagedBytes = 0;
    const current = () => generation === this.generation;
    return {
      get: (url) => (current() ? this.entries.get(url) : undefined),
      set: (url, read) => {
        if (!current()) return;
        const total = stagedBytes - (staged.get(url)?.bytes ?? 0) + read.bytes;
        // Bound temporary retention too, before a large catalog can publish.
        if (
          total > MAX_BYTES ||
          (!staged.has(url) && staged.size >= MAX_ENTRIES)
        )
          return;
        staged.set(url, read);
        stagedBytes = total;
      },
      delete: (url) => {
        stagedBytes -= staged.get(url)?.bytes ?? 0;
        staged.delete(url);
        if (current()) this.remove(url);
      },
      commit: () => {
        if (!current()) return;
        for (const [url, read] of staged) this.put(url, read);
        staged.clear();
        stagedBytes = 0;
      },
    };
  }

  clear(): void {
    this.generation++;
    this.entries.clear();
    this.bytes = 0;
  }

  private remove(url: string): void {
    const existing = this.entries.get(url);
    if (!existing) return;
    this.entries.delete(url);
    this.bytes -= existing.bytes;
  }

  private put(url: string, read: StoredRead): void {
    if (read.bytes > MAX_BYTES) return;
    this.remove(url);
    this.entries.set(url, read);
    this.bytes += read.bytes;
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= MAX_ENTRIES && this.bytes <= MAX_BYTES) break;
      this.remove(oldest);
    }
  }
}
