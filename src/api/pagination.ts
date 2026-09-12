import { readUrl } from "../security/policy";
export function nextPage(
  header: string | null,
  origin: string,
  path = "/api/v1/courses",
): string | null {
  if (!header) return null;
  if (header.length > 16000) throw new Error("POLICY");
  const next: string[] = [];
  for (const part of header.split(/,(?=\s*<)/)) {
    const match = /^\s*<([^>]+)>\s*;(.*)$/.exec(part);
    if (!match) throw new Error("POLICY");
    const rel = /(?:^|;)\s*rel\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(match[2]!);
    if (!rel) throw new Error("POLICY");
    if ((rel[1] ?? rel[2] ?? "").split(/\s+/).includes("next"))
      next.push(readUrl(match[1]!, origin, path).href);
  }
  if (next.length > 1) throw new Error("POLICY");
  return next[0] ?? null;
}
