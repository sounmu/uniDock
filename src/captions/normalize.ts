import { redactText } from "../security/redaction";
export interface Caption {
  label: string;
  source: string;
  text: string;
}
export function isKorean(language: string, label: string): boolean {
  const normalized = language.trim().toLowerCase().replaceAll("_", "-");
  return (
    ["ko", "kor", "kr", "ko-kr"].includes(normalized) ||
    normalized.startsWith("ko-") ||
    /korean|한국|한글|국문/i.test(`${language} ${label}`)
  );
}
function entities(text: string): string {
  return text.replace(
    /&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,
    (original, code: string) => {
      if (code.startsWith("#")) {
        const point =
          code[1]?.toLowerCase() === "x"
            ? parseInt(code.slice(2), 16)
            : Number(code.slice(1));
        return point > 0 && point <= 0x10ffff
          ? String.fromCodePoint(point)
          : original;
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
        )[code.toLowerCase()] ?? original
      );
    },
  );
}
export function safeCaptionText(text: string): boolean {
  return (
    text.length > 0 &&
    text.length <= 1000000 &&
    !text.split("\n").some((line) => redactText(line) !== line)
  );
}
export function captionToText(raw: string): string {
  if (raw.length > 1000000) throw new Error("LIMIT");
  let text = raw
    .replace(/^\uFEFF/, "")
    .trim()
    .replace(/\r\n?/g, "\n");
  if (
    /<(?:html|script|style)\b/i.test(text) ||
    /잘못된 요청/.test(text) ||
    /^\s*(?:var|let|const|function|import|export)\b|^\s*(?:window|document|globalThis|self)\.|=>\s*[{(]/m.test(
      text,
    )
  )
    throw new Error("UNSAFE_CAPTION");
  if (text.startsWith("[") || text.startsWith("{")) {
    let nodes = 0;
    const parts: string[] = [];
    const visit = (value: unknown, key = "", depth = 0) => {
      if (++nodes > 30000 || depth > 20) throw new Error("LIMIT");
      if (Array.isArray(value))
        value.forEach((child) => visit(child, key, depth + 1));
      else if (value && typeof value === "object")
        Object.entries(value).forEach(([name, child]) =>
          visit(child, name.toLowerCase(), depth + 1),
        );
      else if (
        typeof value === "string" &&
        [
          "text",
          "caption",
          "subtitle",
          "transcript",
          "script",
          "body",
        ].includes(key)
      )
        parts.push(value);
    };
    try {
      visit(JSON.parse(text));
    } catch {
      throw new Error("UNSAFE_CAPTION");
    }
    text = parts.join("\n");
  }
  text = entities(text).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  if (
    /<(?:html|script|style)\b/i.test(text) ||
    /^\s*(?:var|let|const|function|import|export)\b|^\s*(?:window|document|globalThis|self)\.|=>\s*[{(]/m.test(
      text,
    )
  )
    throw new Error("UNSAFE_CAPTION");
  // TTML/SAMI paragraph boundaries, inline emphasis stays on the same line.
  text = text.replace(/<br\s*\/?\s*>|<\/(?:p|div|sync)>/gi, "\n");
  const lines = text.split("\n");
  const output: string[] = [];
  let block = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (block) {
      if (!line) block = false;
      continue;
    }
    if (/^(?:NOTE|STYLE|REGION)(?:\s|$)/.test(line)) {
      block = true;
      continue;
    }
    if (/^WEBVTT(?:\s|$)/.test(line) || line.includes("-->")) continue;
    if (lines[i + 1]?.includes("-->")) continue; // VTT/SRT cue identifier only.
    const clean = line.replace(/<[^>]*>/g, "").trim();
    if (clean || (output.length && output[output.length - 1]))
      output.push(clean);
  }
  const result = output.join("\n").trim();
  if (!result) throw new Error("NO_KOREAN_CAPTIONS");
  if (!safeCaptionText(result)) throw new Error("UNSAFE_CAPTION");
  return `${result}\n`;
}
export function normalizeCaptions(input: unknown): {
  captions: Caption[];
  blocked: boolean;
} {
  if (!Array.isArray(input) || input.length > 40) throw new Error("LIMIT");
  const captions: Caption[] = [];
  let blocked = false,
    total = 0;
  for (const value of input) {
    if (!value || typeof value !== "object") {
      blocked = true;
      continue;
    }
    const row = value as Record<string, unknown>;
    if (
      typeof row.language !== "string" ||
      row.language.length > 100 ||
      typeof row.label !== "string" ||
      row.label.length > 200 ||
      typeof row.text !== "string"
    ) {
      blocked = true;
      continue;
    }
    if (!isKorean(row.language, row.label)) continue;
    if (
      ![
        "track_element",
        "text_track_cues",
        "player_caption_api",
        "caption_script_dom",
      ].includes(String(row.source))
    ) {
      blocked = true;
      continue;
    }
    try {
      const text = captionToText(row.text);
      if (captions.some((item) => item.text === text)) continue;
      total += text.length;
      if (total > 2000000) throw new Error("LIMIT");
      const label =
        redactText(row.label) === row.label ? row.label || "한국어" : "한국어";
      captions.push({ label, source: String(row.source), text });
    } catch {
      blocked = true;
    }
  }
  return { captions, blocked };
}
