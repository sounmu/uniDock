import { redactText } from "./security/redaction";
export interface Course {
  name: string;
}
export function projectCourses(raw: unknown): Course[] {
  if (!Array.isArray(raw) || raw.length > 1000)
    throw new Error("INVALID_RESPONSE");
  return raw.flatMap((item: unknown) => {
    if (!item || typeof item !== "object") throw new Error("INVALID_RESPONSE");
    const row = item as Record<string, unknown>;
    // Canvas may return restricted enrollment objects without a name.
    if (row.name === undefined) return [];
    if (typeof row.name !== "string" || row.name.length > 2000)
      throw new Error("INVALID_RESPONSE");
    const id =
      typeof row.id === "number" || typeof row.id === "string"
        ? String(row.id)
        : "";
    return [{ name: redactText(row.name, [id]).trim() || "이름 없는 과목" }];
  });
}
