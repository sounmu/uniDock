import { accessible, type Metadata, type Recording } from "./recordings";
import { navigationUrl } from "./security/navigation";
import type { Document } from "./documents";
import { lmsFileDownloadUrl } from "./security/download";
export interface RecordingTarget {
  module: string;
  title: string;
  courseId: string;
  itemId?: string;
  moduleAccess: Metadata;
  itemAccess: Metadata;
}
export interface DocumentTarget extends Omit<RecordingTarget, "itemId"> {
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
        expires: now + 300000,
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
        lmsHandle: add(`${origin}/courses/${target.courseId}/modules`, target),
        launchHandle: target.itemId
          ? add(
              `${origin}/courses/${target.courseId}/modules/items/${target.itemId}`,
              target,
            )
          : "",
      }));
      this.timer = setTimeout(() => this.expire(), 300000);
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
          expires: now + 300000,
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
            expires: now + 300000,
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
      this.timer = setTimeout(() => this.expire(), 300000);
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
    return navigationUrl(entry.url, origin);
  }
  /** Validate and spend a playback selection as one operation. */
  takeRecordingBatch(
    handles: readonly string[],
    origin: string,
    now = Date.now(),
  ): string[] | null {
    if (
      this.revoked ||
      handles.length < 1 ||
      handles.length > 100 ||
      new Set(handles).size !== handles.length
    )
      return null;
    const urls: string[] = [];
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
      if (
        !url ||
        !/^\/courses\/[1-9]\d{0,19}\/modules\/items\/[1-9]\d{0,19}$/.test(
          new URL(url).pathname,
        )
      )
        return null;
      if (canonicalUrls.has(url)) return null;
      canonicalUrls.add(url);
      urls.push(url);
    }
    for (const handle of handles) this.remove(handle);
    return urls;
  }
  takeDownload(
    handle: string,
    origin: string,
    now = Date.now(),
  ): { url: string; module: string; title: string } | null {
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
    return url ? { url, module: entry.module, title: entry.title } : null;
  }
}
