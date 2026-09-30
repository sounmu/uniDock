import { normalizeItems, transcriptText, type Transcript } from "./transcript";
export function exportTranscript(value: Transcript): {
  json: string;
  text: string;
} {
  const items = normalizeItems(value.items);
  if (
    !items.length ||
    items.length !== value.itemCount ||
    !Number.isFinite(Date.parse(value.extractedAt))
  )
    throw new Error("INVALID_CAPTION");
  const source = new URL(value.sourceUrl);
  if (source.protocol !== "https:" || source.username || source.password)
    throw new Error("INVALID_CAPTION");
  // Explicit projection prevents player resource URLs/configuration leaking into JSON.
  const transcript: Transcript = {
    sourceUrl: value.sourceUrl,
    pageTitle: value.pageTitle,
    extractedAt: value.extractedAt,
    itemCount: items.length,
    items,
  };
  return {
    json: JSON.stringify(transcript, null, 2) + "\n",
    text: transcriptText(transcript),
  };
}
export type CaptionDownloadResult =
  { status: "complete" } | { status: "partial"; accepted: 0 | 1 };

export async function downloadCaption(
  value: Transcript,
  options: { signal?: AbortSignal; isCurrent?: () => boolean } = {},
): Promise<CaptionDownloadResult> {
  const files = exportTranscript(value);
  const timestamp = value.extractedAt
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  const nonce = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  const stem = `output/uniDock-${timestamp}-${nonce}`;
  let accepted: 0 | 1 | 2 = 0;
  const canContinue = () =>
    !options.signal?.aborted && (options.isCurrent?.() ?? true);
  for (const [extension, body, type] of [
    ["txt", files.text, "text/plain"],
    ["json", files.json, "application/json"],
  ] as const) {
    if (!canContinue())
      return { status: "partial", accepted: accepted as 0 | 1 };
    const url = URL.createObjectURL(
      new Blob([body], { type: `${type};charset=utf-8` }),
    );
    try {
      if (!canContinue())
        return { status: "partial", accepted: accepted as 0 | 1 };
      await chrome.downloads.download({
        url,
        filename: `${stem}.${extension}`,
        conflictAction: "uniquify",
        saveAs: false,
      });
      accepted++;
    } catch {
      return { status: "partial", accepted: accepted as 0 | 1 };
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  return { status: "complete" };
}
