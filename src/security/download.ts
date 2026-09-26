import { allowedPage } from "./policy";
import { redactText } from "./redaction";

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

export function safeDownloadPath(
  course: string,
  module: string,
  title: string,
): string | null {
  const segments = [course, module, title].map(
    (value) =>
      redactText(value)
        // eslint-disable-next-line no-control-regex
        .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
        .replace(/^[\s.]+|[\s.]+$/g, "")
        .slice(0, 80)
        .replace(/[\s.]+$/g, "") || "_",
  );
  const name = segments[2] ?? "_";
  segments[2] = /\.pdf$/i.test(name) ? name : `${name.slice(0, 76)}.pdf`;
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
    segments.length === 4 &&
    /\.pdf$/i.test(value) &&
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
