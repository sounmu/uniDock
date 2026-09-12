import { validDate } from "../protocol";
export const LMS_ORIGINS = [
  "https://mylms.korea.ac.kr",
  "https://canvas.korea.ac.kr",
] as const;
export const LMS_MATCHES = LMS_ORIGINS.map((origin) => `${origin}/*`);
export function allowedPage(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      LMS_ORIGINS.some((origin) => origin === url.origin) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}
// No generic proxy. All requests are generated internally for these GET lists.
export function readUrl(
  value: string,
  origin: string,
  expectedPath: string,
): URL {
  if (!LMS_ORIGINS.some((item) => item === origin)) throw new Error("POLICY");
  const url = new URL(value, origin);
  const assignments = /^\/api\/v1\/courses\/[1-9]\d*\/assignments$/.test(
    expectedPath,
  );
  const modules = /^\/api\/v1\/courses\/[1-9]\d*\/modules$/.test(expectedPath);
  const moduleItems =
    /^\/api\/v1\/courses\/[1-9]\d*\/modules\/[1-9]\d*\/items$/.test(
      expectedPath,
    );
  const courses = expectedPath === "/api/v1/courses",
    planner = expectedPath === "/api/v1/planner/items";
  if (!(
    assignments ||
    modules ||
    moduleItems ||
    courses ||
    planner ||
    expectedPath === "/api/v1/users/self/todo"
  ))
    throw new Error("POLICY");
  if (
    !allowedPage(url.href) ||
    url.origin !== origin ||
    url.pathname !== expectedPath ||
    url.hash
  )
    throw new Error("POLICY");
  const permitted = [
    "per_page",
    "page",
    ...(courses ? ["enrollment_state"] : []),
    ...(assignments || modules || moduleItems ? ["include[]"] : []),
    ...(planner ? ["start_date", "end_date"] : []),
  ];
  for (const [key, val] of url.searchParams) {
    if (
      !permitted.includes(key) ||
      (key !== "include[]" && url.searchParams.getAll(key).length !== 1)
    )
      throw new Error("POLICY");
    if (
      key === "per_page" &&
      (!/^\d{1,3}$/.test(val) || Number(val) < 1 || Number(val) > 100)
    )
      throw new Error("POLICY");
    if (key === "page" && !/^[1-9]\d{0,5}$/.test(val))
      throw new Error("POLICY");
    if (key === "enrollment_state" && val !== "active")
      throw new Error("POLICY");
    if (key === "include[]") {
      const values = url.searchParams.getAll(key);
      const includes = assignments
        ? ["submission"]
        : modules
          ? ["items", "content_details"]
          : ["content_details"];
      if (!includes.includes(val) || new Set(values).size !== values.length)
        throw new Error("POLICY");
    }
    if ((key === "start_date" || key === "end_date") && !validDate(val))
      throw new Error("POLICY");
  }
  const start = url.searchParams.get("start_date"),
    end = url.searchParams.get("end_date");
  if (start && end && start > end) throw new Error("POLICY");
  return url;
}
export function courseUrl(value: string, origin: string): URL {
  return readUrl(value, origin, "/api/v1/courses");
}
