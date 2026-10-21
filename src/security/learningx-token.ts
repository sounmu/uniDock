// LearningX board APIs authenticate with the bearer token LearningX itself
// keeps in a page-readable cookie. It is read per request inside the content
// script, attached only to fixed GET board paths, and never stored, logged,
// returned, or sent to other extension contexts.
export function learningxToken(cookie: unknown): string | null {
  if (typeof cookie !== "string" || cookie.length > 16384) return null;
  const values = cookie
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith("xn_api_token="))
    .map((part) => part.slice("xn_api_token=".length));
  const value = values.length === 1 ? values[0]! : "";
  // A JWT: three base64url segments, bounded.
  return value.length <= 4096 &&
    /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)
    ? value
    : null;
}
