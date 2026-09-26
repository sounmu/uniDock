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
// Content-script memory only. UUIDs are one-use capabilities, unrelated to LMS IDs.
export class NavigationCatalog {
  private entries = new Map<string, Entry>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  clear(): void {
    this.entries.clear();
    clearTimeout(this.timer);
  }
  replace(
    origin: string,
    targets: RecordingTarget[],
    now = Date.now(),
  ): Recording[] {
    this.clear();
    if (targets.length > 10000) throw new Error("LIMIT");
    const add = (url: string, target: RecordingTarget): string => {
      const safe = navigationUrl(url, origin);
      if (!safe) throw new Error("POLICY");
      const handle = crypto.randomUUID();
      this.entries.set(handle, {
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
      this.timer = setTimeout(() => this.clear(), 300000);
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
    this.clear();
    if (targets.length > 10000) throw new Error("LIMIT");
    try {
      const result = targets.map((target) => {
        const url = navigationUrl(
          `${origin}/courses/${target.courseId}/modules/items/${target.itemId}`,
          origin,
        );
        if (!url) throw new Error("POLICY");
        const lmsHandle = crypto.randomUUID();
        this.entries.set(lmsHandle, {
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
          this.entries.set(downloadHandle, {
            url: downloadUrl,
            kind: "download",
            module: target.module,
            title: target.title,
            expires: now + 300000,
            moduleAccess: target.moduleAccess,
            itemAccess: target.itemAccess,
          });
        }
        return {
          module: target.module,
          title: target.title,
          type: "File" as const,
          lmsHandle,
          downloadHandle,
        };
      });
      this.timer = setTimeout(() => this.clear(), 300000);
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
    const entry = this.entries.get(handle);
    this.entries.delete(handle);
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
  takeDownload(
    handle: string,
    origin: string,
    now = Date.now(),
  ): { url: string; module: string; title: string } | null {
    const entry = this.entries.get(handle);
    this.entries.delete(handle);
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
