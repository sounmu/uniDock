import { redactText } from "./security/redaction";
export interface Course {
  name: string;
  courseSelector: string;
}
export interface InternalCourse {
  id: string;
  name: string;
}
export function projectCourseIndex(raw: unknown): InternalCourse[] {
  if (!Array.isArray(raw) || raw.length > 1000)
    throw new Error("INVALID_RESPONSE");
  return raw.flatMap((item: unknown) => {
    if (!item || typeof item !== "object") throw new Error("INVALID_RESPONSE");
    const row = item as Record<string, unknown>;
    if (
      row.name !== undefined &&
      (typeof row.name !== "string" || row.name.length > 2000)
    )
      throw new Error("INVALID_RESPONSE");
    // Date-restricted enrollments cannot be queried; one would fail every aggregate.
    if (row.access_restricted_by_date === true) return [];
    const id =
      typeof row.id === "string" ||
      (typeof row.id === "number" && Number.isSafeInteger(row.id))
        ? String(row.id)
        : "";
    if (!/^[1-9]\d{0,19}$/.test(id)) return [];
    const name = typeof row.name === "string" ? row.name : "";
    return [{ id, name: redactText(name, [id]).trim() || "이름 없는 과목" }];
  });
}

/** Legacy name-only projection used by the API contract tests, never a picker. */
export function projectCourses(raw: unknown): Pick<Course, "name">[] {
  if (!Array.isArray(raw) || raw.length > 1000)
    throw new Error("INVALID_RESPONSE");
  return projectCourseIndex(
    raw.filter(
      (item) =>
        item !== null &&
        typeof item === "object" &&
        (item as Record<string, unknown>).name !== undefined,
    ),
  ).map(({ name }) => ({ name }));
}
