import { allowedPage } from "./policy";
import { redactText } from "./redaction";
import { documentExtension } from "../documents";

// Downloads are capabilities for one canonical route, never a network proxy.
export function lmsFileDownloadUrl(
  value: unknown,
  source: string,
): string | null {
  if (typeof value !== "string" || value.length > 300 || !allowedPage(source))
    return null;
  try {
    const url = new URL(value);
    if (
      !allowedPage(value) ||
      url.origin !== new URL(source).origin ||
      value.includes("#") ||
      url.search !== "?download_frd=1" ||
      !/^\/courses\/[1-9]\d{0,19}\/files\/[1-9]\d{0,19}\/download$/.test(
        url.pathname,
      ) ||
      url.href !== value
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}

// LMS course titles carry a term code, campus/language tags, an English
// title and a section suffix: "262R (서울-학부)과목명(영강)(English)-00분반".
// Keep only the course name for the download folder.
export function courseFolderName(course: string): string {
  let name = course.replace(/^\s*\d{2,4}[A-Z]?\s+/, "");
  for (let previous = ""; previous !== name; ) {
    previous = name;
    name = name.replace(/[(（][^()（）]*[)）]/g, " ");
  }
  name = name
    .replace(/\s*-\s*\d+\s*분반\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
  return name || course;
}

export function safeDownloadPath(
  course: string,
  title: string,
): string | null {
  const segments = [courseFolderName(course), title].map(
    (value) =>
      redactText(value)
        // eslint-disable-next-line no-control-regex
        .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
        .replace(/^[\s.]+|[\s.]+$/g, "")
        .slice(0, 80)
        .replace(/[\s.]+$/g, "") || "_",
  );
  const name = segments[1] ?? "_";
  const extension = documentExtension(title) ?? "pdf";
  const stem = name.replace(/\.(?:pdf|pptx|ppt)$/i, "");
  segments[1] =
    documentExtension(name) === extension
      ? name
      : `${stem.slice(0, 79 - extension.length)}.${extension}`;
  const path = `uniDock/${segments.join("/")}`;
  return validDownloadPath(path) ? path : null;
}

// Also used at the background boundary, which must not trust caller filenames.
export function validDownloadPath(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length > 240 ||
    !value.startsWith("uniDock/")
  )
    return false;
  const segments = value.split("/");
  return (
    segments.length === 3 &&
    /\.(?:pdf|pptx|ppt)$/i.test(value) &&
    segments.slice(1).every(
      (segment) =>
        segment.length > 0 &&
        segment.length <= 80 &&
        !/^[\s.]|[\s.]$/.test(segment) &&
        // eslint-disable-next-line no-control-regex
        !/[\\:*?"<>|\u0000-\u001f\u007f]/.test(segment) &&
        redactText(segment) === segment,
    )
  );
}
