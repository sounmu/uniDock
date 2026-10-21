import { accessible, recordingLabel, type Metadata } from "./recordings";

export interface Document {
  module: string;
  /** Instructor-facing item title; falls back to the file name. */
  title: string;
  /** Actual file name with its extension; also the saved file name. */
  filename: string;
  type: "File";
  lmsHandle: string;
  downloadHandle: string;
}

export function documentExtension(
  value: string,
): "pdf" | "pptx" | "ppt" | null {
  const extension = /\.(pdf|pptx|ppt)\s*$/i.exec(value)?.[1]?.toLowerCase();
  return extension === "pdf" || extension === "pptx" || extension === "ppt"
    ? extension
    : null;
}

export function documentMimeMatches(filename: string, mime: string): boolean {
  const expected = {
    pdf: "application/pdf",
    ppt: "application/vnd.ms-powerpoint",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  };
  const extension = documentExtension(filename);
  return extension !== null && mime.toLowerCase() === expected[extension];
}

export function documentFilename(item: Metadata): string | null {
  const details = item.content_details as Metadata | undefined;
  for (const value of [
    details?.display_name,
    item.display_name,
    item.filename,
    item.title,
  ]) {
    if (typeof value !== "string" || value.length > 2000) continue;
    const label = recordingLabel(value).trim();
    if (documentExtension(label)) return label;
  }
  return null;
}

// Do not infer file type from signed URLs or content IDs.
export function documentCandidate(item: Metadata, now = Date.now()): boolean {
  if (item.type !== "File" || !accessible(item, now)) return false;
  const details = item.content_details as Metadata | undefined;
  for (const value of [item.title, details?.display_name]) {
    if (value != null && (typeof value !== "string" || value.length > 2000))
      return false;
  }
  return documentFilename(item) !== null;
}
