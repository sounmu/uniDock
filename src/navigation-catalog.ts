import { accessible, type Metadata, type Recording } from "./recordings";
import { navigationUrl, playerUrl } from "./security/navigation";
import type { Document } from "./documents";
import { lmsFileDownloadUrl } from "./security/download";
export interface RecordingTarget {
  module: string;
  title: string;
  courseId: string;
  itemId?: string;
  /** LearningX board course tool the post lives in (board videos only). */
  boardToolId?: string;
  /** Canonical KU player page embedded in the post (board videos only). */
  playerUrl?: string;
  moduleAccess: Metadata;
  itemAccess: Metadata;
}
export interface DocumentTarget extends Omit<
  RecordingTarget,
  "itemId" | "boardToolId" | "playerUrl"
> {
  itemId: string;
  filename: string;
  topicId?: string;
  /** LearningX board course tool; the post lives inside that tool. */
  boardToolId?: string;
  fileId?: string;
}
interface Entry {
  url: string;
  kind: "recording" | "document" | "download";
  module?: string;
  title?: string;
  expires: number;
  moduleAccess: Metadata;
  itemAccess: Metadata;
}
/** How long an admitted caption batch waits for its next lecture to open. */
export const CAPTION_BATCH_IDLE_MS = 1_800_000;
const moduleItemPath = /^\/courses\/[1-9]\d{0,19}\/modules\/items\/[1-9]\d{0,19}$/;

const HANDLE_TTL_MS = 300_000;

/** Lectures a caption run was admitted for, opened once each by position.
    The list's handles are already spent, so a long upload cannot outlive them. */
export class CaptionBatch {
  private expires: number;
  private readonly used = new Set<number>();
  constructor(
    private readonly targets: readonly Pick<Entry, "url" | "moduleAccess" | "itemAccess">[],
    now: number,
  ) {
    this.expires = now + CAPTION_BATCH_IDLE_MS;
  }
  take(
    index: number,
    origin: string,
    now = Date.now(),
  ): { url: string; restore: () => void } | null {
    const target = this.targets[index];
    if (
      !target ||
      this.used.has(index) ||
      this.expires <= now ||
      !accessible(target.moduleAccess, now) ||
      !accessible(target.itemAccess, now)
    )
      return null;
    const url = navigationUrl(target.url, origin);
    if (!url) return null;
    this.used.add(index);
    this.expires = now + CAPTION_BATCH_IDLE_MS;
    return { url, restore: () => this.used.delete(index) };
  }
}
export interface NavigationCatalogCapacity {
  reserve(count: number): boolean;
  release(count: number): void;
}
// Content-script memory only. UUIDs are one-use capabilities, unrelated to LMS IDs.
export class NavigationCatalog {
  private entries = new Map<string, Entry>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private revoked = false;
  constructor(
    private readonly account?: string,
    private readonly epoch?: number,
    private readonly capacity?: NavigationCatalogCapacity,
    private readonly onPublishedEmpty?: () => void,
  ) {}
  ownedBy(account: string, epoch: number): boolean {
    return !this.revoked && this.account === account && this.epoch === epoch;
  }
  hasOwner(): boolean {
    return (
      !this.revoked && this.account !== undefined && this.epoch !== undefined
    );
  }
  revoke(): void {
    this.revoked = true;
    this.clear();
  }
  clear(): void {
    const released = this.entries.size;
    this.entries.clear();
    if (released) this.capacity?.release(released);
    clearTimeout(this.timer);
  }
  size(): number {
    return this.entries.size;
  }
  has(handle: string): boolean {
    return !this.revoked && this.entries.has(handle);
  }
  private add(handle: string, entry: Entry): void {
    if (!this.capacity?.reserve(1) && this.capacity) throw new Error("LIMIT");
    this.entries.set(handle, entry);
  }
  private remove(handle: string): Entry | undefined {
    const entry = this.entries.get(handle);
    if (entry && this.entries.delete(handle)) this.capacity?.release(1);
    return entry;
  }
  private expire(): void {
    this.clear();
    this.onPublishedEmpty?.();
  }
  replace(
    origin: string,
    targets: RecordingTarget[],
    now = Date.now(),
  ): Recording[] {
    if (this.revoked) throw new Error("STALE_SELECTION");
    this.clear();
    if (targets.length > 10000) throw new Error("LIMIT");
    const add = (url: string, target: RecordingTarget): string => {
      const safe = navigationUrl(url, origin);
      if (!safe) throw new Error("POLICY");
      const handle = crypto.randomUUID();
      this.add(handle, {
        url: safe,
        kind: "recording",
        expires: now + HANDLE_TTL_MS,
        moduleAccess: target.moduleAccess,
        itemAccess: target.itemAccess,
      });
      return handle;
    };
    try {
      const result = targets.map((target) => ({
        module: target.module,
        title: target.title,
        type: "ExternalTool" as const,
        source: target.playerUrl ? ("board" as const) : ("module" as const),
        lmsHandle: add(
          target.boardToolId
            ? `${origin}/courses/${target.courseId}/external_tools/${target.boardToolId}`
            : `${origin}/courses/${target.courseId}/modules`,
          target,
        ),
        launchHandle: target.playerUrl
          ? add(target.playerUrl, target)
          : target.itemId
            ? add(
                `${origin}/courses/${target.courseId}/modules/items/${target.itemId}`,
                target,
              )
            : "",
      }));
      this.timer = setTimeout(() => this.expire(), HANDLE_TTL_MS);
      return result;
    } catch (error) {
      this.clear();
      throw error;
    }
  }
  replaceDocuments(
    origin: string,
    targets: DocumentTarget[],
    now = Date.now(),
  ): Document[] {
    if (this.revoked) throw new Error("STALE_SELECTION");
    this.clear();
    if (targets.length > 10000) throw new Error("LIMIT");
    try {
      const result = targets.map((target) => {
        const url = navigationUrl(
          target.boardToolId
            ? `${origin}/courses/${target.courseId}/external_tools/${target.boardToolId}`
            : target.topicId
              ? `${origin}/courses/${target.courseId}/discussion_topics/${target.topicId}`
              : `${origin}/courses/${target.courseId}/modules/items/${target.itemId}`,
          origin,
        );
        if (!url) throw new Error("POLICY");
        const lmsHandle = crypto.randomUUID();
        this.add(lmsHandle, {
          url,
          kind: "document",
          expires: now + HANDLE_TTL_MS,
          moduleAccess: target.moduleAccess,
          itemAccess: target.itemAccess,
        });
        let downloadHandle = "";
        if (target.fileId) {
          const downloadUrl = lmsFileDownloadUrl(
            `${origin}/courses/${target.courseId}/files/${target.fileId}/download?download_frd=1`,
            origin,
          );
          if (!downloadUrl) throw new Error("POLICY");
          downloadHandle = crypto.randomUUID();
          this.add(downloadHandle, {
            url: downloadUrl,
            kind: "download",
            module: target.module,
            // Downloads are saved under the actual file name, not the item title.
            title: target.filename,
            expires: now + HANDLE_TTL_MS,
            moduleAccess: target.moduleAccess,
            itemAccess: target.itemAccess,
          });
        }
        return {
          module: target.module,
          title: target.title,
          filename: target.filename,
          type: "File" as const,
          lmsHandle,
          downloadHandle,
        };
      });
      this.timer = setTimeout(() => this.expire(), HANDLE_TTL_MS);
      return result;
    } catch (error) {
      this.clear();
      throw error;
    }
  }
  take(
    handle: string,
    origin: string,
    now = Date.now(),
    kind?: "recording" | "document",
  ): string | null {
    return this.takeOpen(handle, origin, now, kind)?.url ?? null;
  }
  /** Spends an open capability; `restore` returns it when the background refused it unused. */
  takeOpen(
    handle: string,
    origin: string,
    now = Date.now(),
    kind?: "recording" | "document",
  ): { url: string; restore: () => boolean } | null {
    if (this.revoked) return null;
    const entry = this.remove(handle);
    if (
      !entry ||
      entry.kind === "download" ||
      (kind !== undefined && entry.kind !== kind) ||
      entry.expires <= now ||
      !accessible(entry.moduleAccess, now) ||
      !accessible(entry.itemAccess, now)
    )
      return null;
    const url = navigationUrl(entry.url, origin);
    return url ? { url, restore: this.restorer(handle, entry) } : null;
  }
  // One-shot: puts a spent capability back only if this catalog is still live
  // and the entry has not expired. Nothing about it is extended.
  private restorer(handle: string, entry: Entry): () => boolean {
    let restored = false;
    return () => {
      if (
        restored ||
        this.revoked ||
        this.entries.has(handle) ||
        entry.expires <= Date.now()
      )
        return false;
      try {
        this.add(handle, entry);
      } catch {
        return false;
      }
      restored = true;
      return true;
    };
  }
  /** Validate and spend a playback selection as one operation. */
  takeRecordingBatch(
    handles: readonly string[],
    origin: string,
    now = Date.now(),
  ): string[] | null {
    return (
      this.spendBatch(handles, origin, now, (url) =>
        moduleItemPath.test(new URL(url).pathname),
      )?.map((target) => target.url) ?? null
    );
  }
  /** Validate and spend a caption selection, module lectures or board players. */
  takeCaptionBatch(
    handles: readonly string[],
    origin: string,
    now = Date.now(),
  ): CaptionBatch | null {
    const targets = this.spendBatch(
      handles,
      origin,
      now,
      (url) => playerUrl(url) === url || moduleItemPath.test(new URL(url).pathname),
    );
    return targets ? new CaptionBatch(targets, now) : null;
  }
  private spendBatch(
    handles: readonly string[],
    origin: string,
    now: number,
    launch: (url: string) => boolean,
  ): Pick<Entry, "url" | "moduleAccess" | "itemAccess">[] | null {
    if (
      this.revoked ||
      handles.length < 1 ||
      handles.length > 100 ||
      new Set(handles).size !== handles.length
    )
      return null;
    const targets: Pick<Entry, "url" | "moduleAccess" | "itemAccess">[] = [];
    const canonicalUrls = new Set<string>();
    for (const handle of handles) {
      const entry = this.entries.get(handle);
      if (
        !entry ||
        entry.kind !== "recording" ||
        entry.expires <= now ||
        !accessible(entry.moduleAccess, now) ||
        !accessible(entry.itemAccess, now)
      )
        return null;
      const url = navigationUrl(entry.url, origin);
      // A recording's course page shares its kind; only launch targets count.
      if (!url || !launch(url) || canonicalUrls.has(url)) return null;
      canonicalUrls.add(url);
      targets.push({ url, moduleAccess: entry.moduleAccess, itemAccess: entry.itemAccess });
    }
    for (const handle of handles) this.remove(handle);
    return targets;
  }
  takeDownload(
    handle: string,
    origin: string,
    now = Date.now(),
  ): {
    url: string;
    module: string;
    title: string;
    restore: () => boolean;
  } | null {
    if (this.revoked) return null;
    const entry = this.remove(handle);
    if (
      !entry ||
      entry.kind !== "download" ||
      entry.expires <= now ||
      !accessible(entry.moduleAccess, now) ||
      !accessible(entry.itemAccess, now) ||
      entry.module === undefined ||
      entry.title === undefined
    )
      return null;
    const url = lmsFileDownloadUrl(entry.url, origin);
    return url
      ? {
          url,
          module: entry.module,
          title: entry.title,
          restore: this.restorer(handle, entry),
        }
      : null;
  }
}
