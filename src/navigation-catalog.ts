import { accessible, type Metadata, type Recording } from './recordings';
import { navigationUrl } from './security/navigation';
export interface RecordingTarget { module: string; title: string; courseId: string; itemId?: string; moduleAccess: Metadata; itemAccess: Metadata }
interface Entry { url: string; expires: number; moduleAccess: Metadata; itemAccess: Metadata }
// Content-script memory only. UUIDs are one-use capabilities, unrelated to LMS IDs.
export class NavigationCatalog {
  private entries = new Map<string, Entry>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  clear(): void { this.entries.clear(); clearTimeout(this.timer); }
  replace(origin: string, targets: RecordingTarget[], now = Date.now()): Recording[] {
    this.clear();
    if (targets.length > 10000) throw new Error('LIMIT');
    const add = (url: string, target: RecordingTarget): string => {
      const safe = navigationUrl(url, origin);
      if (!safe) throw new Error('POLICY');
      const handle = crypto.randomUUID();
      this.entries.set(handle, {url:safe,expires:now + 300000,moduleAccess:target.moduleAccess,itemAccess:target.itemAccess});
      return handle;
    };
    try {
      const result = targets.map(target => ({module:target.module,title:target.title,type:'ExternalTool' as const,
        lmsHandle:add(`${origin}/courses/${target.courseId}/modules`,target),
        launchHandle:target.itemId ? add(`${origin}/courses/${target.courseId}/modules/items/${target.itemId}`,target) : '',
      }));
      this.timer = setTimeout(() => this.clear(), 300000);
      return result;
    } catch (error) { this.clear(); throw error; }
  }
  take(handle: string, origin: string, now = Date.now()): string | null {
    const entry = this.entries.get(handle);
    this.entries.delete(handle);
    if (!entry || entry.expires <= now || !accessible(entry.moduleAccess,now) || !accessible(entry.itemAccess,now)) return null;
    return navigationUrl(entry.url,origin);
  }
}
