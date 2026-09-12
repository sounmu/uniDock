import { isoTime } from './domain-items';
import { redactText } from './security/redaction';
export interface Recording { module: string; title: string; type: 'ExternalTool'; lmsHandle: string; launchHandle: string }
export type Metadata = Record<string, unknown>;
export function internalId(value: unknown): string | undefined {
  if (typeof value !== 'string' && !(typeof value === 'number' && Number.isSafeInteger(value))) return;
  return /^[1-9]\d{0,19}$/.test(String(value)) ? String(value) : undefined;
}
export function accessible(row: Metadata, now = Date.now()): boolean {
  const details = row.content_details;
  if (details != null && (typeof details !== 'object' || Array.isArray(details))) return false;
  for (const value of [row, (details ?? {}) as Metadata]) {
    if (value.published === false || value.locked_for_user || value.state === 'locked') return false;
    for (const key of ['unlock_at', 'lock_at'] as const) {
      if (!value[key]) continue;
      if (typeof value[key] !== 'string') return false;
      const time = isoTime(value[key]);
      if (!Number.isFinite(time) || (key === 'unlock_at' ? time > now : time <= now)) return false;
    }
  }
  return true;
}
export function recordingCandidate(item: Metadata, now = Date.now()): boolean {
  if (item.type !== 'ExternalTool' || !accessible(item, now)) return false;
  if (item.title != null && (typeof item.title !== 'string' || item.title.length > 2000)) return false;
  const compact = ((item.title ?? '') as string).replaceAll(' ', '');
  return !(compact.includes('교안') || compact.includes('강의자료') || compact === '자료')
    && Boolean((typeof item.html_url === 'string' && item.html_url) || (typeof item.url === 'string' && item.url));
}
export function recordingLabel(value: unknown): string {
  if (value == null) return '';
  if (typeof value !== 'string' || value.length > 2000) throw new Error('INVALID_RESPONSE');
  // Numeric metadata IDs can also be dates or lesson numbers in display labels.
  // Keep IDs out of the public projection instead of replacing matching digits.
  return redactText(value);
}
// Retain only availability fields, never raw API objects or URLs.
export function availabilitySnapshot(row: Metadata): Metadata {
  const pick = (value: Metadata) => Object.fromEntries(['published','locked_for_user','state','unlock_at','lock_at'].filter(key => key in value).map(key => [key,value[key]]));
  return { ...pick(row), content_details: pick((row.content_details ?? {}) as Metadata) };
}
