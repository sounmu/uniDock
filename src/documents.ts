import { accessible, recordingLabel, type Metadata } from "./recordings";

export interface Document {
  module: string;
  title: string;
  type: "File";
  lmsHandle: string;
  downloadHandle: string;
}

// Do not infer file type from signed URLs or content IDs.
export function documentCandidate(item: Metadata, now: number): boolean {
  if (item.type !== "File" || !accessible(item, now)) return false;
  const details = item.content_details as Metadata | undefined;
  for (const value of [item.title, details?.display_name]) {
    if (value != null && (typeof value !== "string" || value.length > 2000))
      return false;
  }
  return [item.title, details?.display_name].some(
    (value) =>
      typeof value === "string" &&
      /\.pdf\s*$/i.test(recordingLabel(value).trim()),
  );
}
