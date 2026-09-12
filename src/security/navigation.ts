import { allowedPage } from "./policy";
// Tabs may open only clean, canonical LMS course/module-item routes. No LTI URL proxy.
export function navigationUrl(value: unknown, source: string): string | null {
  if (typeof value !== "string" || value.length > 300 || !allowedPage(source))
    return null;
  try {
    const url = new URL(value);
    if (
      !allowedPage(value) ||
      url.origin !== new URL(source).origin ||
      url.search ||
      url.hash
    )
      return null;
    if (
      !/^\/courses\/[1-9]\d{0,19}\/modules(?:\/items\/[1-9]\d{0,19})?$/.test(
        url.pathname,
      )
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}
