/** The exported transcript format. Times are cue starts, without milliseconds. */
export interface TranscriptItem {
  index: number;
  time: string;
  text: string;
}
export interface Transcript {
  sourceUrl: string;
  pageTitle: string;
  extractedAt: string;
  itemCount: number;
  items: TranscriptItem[];
}
export function formatTime(raw: string): string {
  const match = /^(?:(\d{2,}):)?(\d{2}):(\d{2})(?:[.,]\d{1,3})?$/.exec(
    raw.trim(),
  );
  if (!match || Number(match[2]) > 59 || Number(match[3]) > 59)
    throw new Error("INVALID_TIME");
  const hours = Number(match[1] ?? 0);
  return `${hours ? `${String(hours).padStart(2, "0")}:` : ""}${match[2]}:${match[3]}`;
}
export function cleanText(raw: string): string {
  return raw
    .replace(/<br\s*\/?\s*>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp|#\d+|#x[0-9a-f]+);/gi, (entity) => {
      const code = entity.slice(1, -1).toLowerCase();
      if (code.startsWith("#")) {
        const value = code.startsWith("#x")
          ? parseInt(code.slice(2), 16)
          : Number(code.slice(1));
        return value > 0 && value <= 0x10ffff
          ? String.fromCodePoint(value)
          : entity;
      }
      return (
        (
          {
            amp: "&",
            lt: "<",
            gt: ">",
            quot: '"',
            apos: "'",
            nbsp: " ",
          } as Record<string, string>
        )[code] ?? entity
      );
    })
    .replace(/\s+/g, " ")
    .trim();
}
export function normalizeItems(input: unknown): TranscriptItem[] {
  if (!Array.isArray(input) || input.length > 20000) throw new Error("LIMIT");
  let size = 0;
  return input.map((item: unknown, index) => {
    if (!item || typeof item !== "object") throw new Error("INVALID_CAPTION");
    const row = item as Record<string, unknown>;
    if (typeof row.time !== "string" || typeof row.text !== "string")
      throw new Error("INVALID_CAPTION");
    // DOM textContent is already decoded; do not interpret it as markup.
    const text = row.text.replace(/\s+/g, " ").trim();
    size += text.length;
    if (size > 1000000) throw new Error("LIMIT");
    if (!text) throw new Error("INVALID_CAPTION");
    return { index, time: row.time === "" ? "" : formatTime(row.time), text };
  });
}
export function parseVtt(raw: string): TranscriptItem[] {
  if (raw.length > 1000000) throw new Error("LIMIT");
  const content = raw
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .trim();
  if (!/^WEBVTT(?:[ \t]|\n|$)/.test(content)) throw new Error("INVALID_VTT");
  const items: { time: string; text: string }[] = [];
  for (const block of content.split(/\n[ \t]*\n/)) {
    const lines = block.split("\n");
    if (/^(?:WEBVTT|NOTE|STYLE|REGION)(?:\s|$)/.test(lines[0] ?? "")) continue;
    const at = lines.findIndex((line) => line.includes("-->"));
    if (at < 0) continue;
    if (at > 1) throw new Error("INVALID_VTT");
    const match =
      /^\s*((?:\d{2,}:)?\d{2}:\d{2}\.\d{3})\s+-->\s+((?:\d{2,}:)?\d{2}:\d{2}\.\d{3})(?:\s+.*)?$/.exec(
        lines[at]!,
      );
    if (!match) throw new Error("INVALID_VTT");
    formatTime(match[2]!);
    const text = cleanText(lines.slice(at + 1).join(" "));
    if (text) items.push({ time: formatTime(match[1]!), text });
  }
  return normalizeItems(items);
}
export function transcriptText(value: Transcript): string {
  return (
    value.items
      .map((item) => `${item.time ? item.time + " " : ""}${item.text}`)
      .join("\n") + "\n"
  );
}

/** KU TXT scripts contain wall-clock ranges, not necessarily video-relative times. */
export function parseMediaScript(raw: string): TranscriptItem[] {
  if (raw.length > 1000000) throw new Error("LIMIT");
  const text = raw
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .trim();
  if (!text || /<(?:!doctype|html|script)\b/i.test(text))
    throw new Error("INVALID_SCRIPT");
  if (/^WEBVTT(?:\s|$)/.test(text)) return parseVtt(text);
  const items: { time: string; text: string }[] = [];
  let current: { time: string; text: string } | undefined;
  for (const line of text.split("\n")) {
    const range =
      /^\s*\[((?:\d{2,}:)?\d{2}:\d{2}(?:[.,]\d{1,3})?)\s*[~–-]\s*((?:\d{2,}:)?\d{2}:\d{2}(?:[.,]\d{1,3})?)\]\s*$/.exec(
        line,
      );
    if (range) {
      if (current?.text.trim()) items.push(current);
      formatTime(range[2]!);
      current = { time: formatTime(range[1]!), text: "" };
    } else if (current) current.text += ` ${line}`;
  }
  if (current?.text.trim()) items.push(current);
  // Untimed scripts remain untimed. Do not invent a 00:00 start.
  return normalizeItems(items.length ? items : [{ time: "", text }]);
}
