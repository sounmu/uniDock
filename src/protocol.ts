import { itemUrl } from "./security/item-link";
import { fields, resultKey } from "./protocol-fields";
import { type Recording } from "./recordings";
import { type Document } from "./documents";
import { type Course } from "./domain";
import {
  type Assignment,
  type Deadline,
  type Upcoming,
  type Todo,
  isoTime,
} from "./domain-items";
import { redactText } from "./security/redaction";
export const errors = [
  "LOGIN_REQUIRED",
  "OPEN_LMS",
  "RELOAD_TAB",
  "FORBIDDEN",
  "NETWORK",
  "TIMEOUT",
  "INVALID_RESPONSE",
  "POLICY",
  "LIMIT",
  "COURSE_NOT_FOUND",
  "COURSE_AMBIGUOUS",
  "BUSY",
  "STALE_SELECTION",
  "TAB_OPEN_FAILED",
  "DOWNLOAD_FAILED",
] as const;
export type ErrorCode = (typeof errors)[number];
export type ListRequest =
  | { version: 1; type: "COURSES_LIST" }
  | { version: 1; type: "TODO_LIST" }
  | {
      version: 1;
      type:
        | "ASSIGNMENTS_LIST"
        | "DEADLINES_LIST"
        | "RECORDINGS_LIST"
        | "DOCUMENTS_LIST";
      course: string;
      courseSelector?: never;
    }
  | {
      version: 1;
      type:
        | "ASSIGNMENTS_LIST"
        | "DEADLINES_LIST"
        | "RECORDINGS_LIST"
        | "DOCUMENTS_LIST";
      courseSelector: string;
      course?: never;
    }
  | {
      version: 1;
      type: "UPCOMING_LIST";
      start_date?: string;
      end_date?: string;
    };
export type CapabilityListRequest =
  | {
      version: 1;
      type: "COURSES_LIST";
    }
  | Extract<ListRequest, { course: string } | { courseSelector: string }>;
export type Request =
  | ListRequest
  | { version: 1; type: "DOCUMENT_DOWNLOAD"; handle: string; course: string }
  | { version: 1; type: "RECORDING_OPEN" | "DOCUMENT_OPEN"; handle: string };
export type PanelQueryMessage =
  | Exclude<Request, { type: "DOCUMENT_DOWNLOAD" }>
  | {
      version: 1;
      type: "DOCUMENT_DOWNLOAD_REQUEST";
      deadline: number;
      request: Extract<Request, { type: "DOCUMENT_DOWNLOAD" }>;
    }
  | {
      version: 1;
      type: "QUERY_REFRESH";
      request: ListRequest;
    }
  | {
      version: 1;
      type: "CAPABILITY_LIST";
      scope: string;
      refresh: boolean;
      request: CapabilityListRequest;
    };
export function validHandle(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value,
    )
  );
}
export const DOWNLOAD_REQUEST_WINDOW_MS = 23_000;
export function validDownloadDeadline(
  value: unknown,
  now = Date.now(),
): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value > now &&
    value <= now + DOWNLOAD_REQUEST_WINDOW_MS
  );
}
export type Result =
  | { status: "success"; recordings: Recording[] }
  | { status: "success"; documents: Document[] }
  | { status: "success"; opened: true }
  | { status: "success"; downloaded: true }
  | { status: "success"; courses: Course[] }
  | { status: "success"; assignments: Assignment[] }
  | { status: "success"; deadlines: Deadline[] }
  | { status: "success"; upcoming: Upcoming[] }
  | { status: "success"; todo: Todo[] }
  | { status: "error"; code: ErrorCode };
export const request = { version: 1, type: "COURSES_LIST" } as const;
export function validDate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(isoTime(value))
  );
}
export function isRequest(value: unknown): value is Request {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  if (row.version !== 1) return false;
  const keys = Object.keys(row);
  if (row.type === "COURSES_LIST" || row.type === "TODO_LIST")
    return keys.length === 2;
  if (row.type === "RECORDING_OPEN" || row.type === "DOCUMENT_OPEN")
    return keys.length === 3 && validHandle(row.handle);
  if (
    row.type === "ASSIGNMENTS_LIST" ||
    row.type === "DEADLINES_LIST" ||
    row.type === "RECORDINGS_LIST" ||
    row.type === "DOCUMENTS_LIST"
  )
    return (
      keys.length === 3 &&
      ((typeof row.course === "string" &&
        row.course.trim().length > 0 &&
        row.course.length <= 2000 &&
        redactText(row.course) === row.course &&
        row.courseSelector === undefined) ||
        (validHandle(row.courseSelector) && row.course === undefined))
    );
  if (row.type === "DOCUMENT_DOWNLOAD")
    return (
      keys.length === 4 &&
      validHandle(row.handle) &&
      typeof row.course === "string" &&
      row.course.trim().length > 0 &&
      row.course.length <= 2000 &&
      redactText(row.course) === row.course &&
      row.courseSelector === undefined
    );
  if (row.type === "UPCOMING_LIST")
    return (
      keys.every((key) =>
        ["version", "type", "start_date", "end_date"].includes(key),
      ) &&
      (row.start_date === undefined || validDate(row.start_date)) &&
      (row.end_date === undefined || validDate(row.end_date)) &&
      !(
        typeof row.start_date === "string" &&
        typeof row.end_date === "string" &&
        row.start_date > row.end_date
      )
    );
  return false;
}
export function panelQuery(value: unknown): {
  request: Request;
  refresh: boolean;
  scope?: string;
  deadline?: number;
} | null {
  if (isRequest(value))
    return value.type === "COURSES_LIST" ||
      value.type === "RECORDINGS_LIST" ||
      value.type === "DOCUMENTS_LIST" ||
      value.type === "DOCUMENT_DOWNLOAD"
      ? null
      : { request: value, refresh: false };
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (row.version !== 1) return null;
  if (row.type === "DOCUMENT_DOWNLOAD_REQUEST") {
    if (
      Object.keys(row).length !== 4 ||
      !validDownloadDeadline(row.deadline) ||
      !isRequest(row.request) ||
      row.request.type !== "DOCUMENT_DOWNLOAD"
    )
      return null;
    return {
      request: row.request,
      refresh: false,
      deadline: row.deadline,
    };
  }
  if (row.type === "CAPABILITY_LIST") {
    if (
      Object.keys(row).length !== 5 ||
      !validHandle(row.scope) ||
      typeof row.refresh !== "boolean" ||
      !isRequest(row.request) ||
      (row.request.type !== "COURSES_LIST" &&
        row.request.type !== "RECORDINGS_LIST" &&
        row.request.type !== "DOCUMENTS_LIST")
    )
      return null;
    return {
      request: row.request as CapabilityListRequest,
      refresh: row.refresh,
      scope: row.scope,
    };
  }
  if (
    row.type !== "QUERY_REFRESH" ||
    Object.keys(row).length !== 3 ||
    !isRequest(row.request)
  )
    return null;
  const request = row.request;
  return request.type.endsWith("_LIST") &&
    request.type !== "COURSES_LIST" &&
    request.type !== "RECORDINGS_LIST" &&
    request.type !== "DOCUMENTS_LIST"
    ? { request: request as ListRequest, refresh: true }
    : null;
}
export function parseResult(
  value: unknown,
  expected?: Request,
  origin?: string,
): Result {
  try {
    if (value && typeof value === "object") {
      const row = value as Record<string, unknown>;
      if (row.status === "error" && errors.includes(row.code as ErrorCode))
        return { status: "error", code: row.code as ErrorCode };
      if (
        row.status === "success" &&
        row.opened === true &&
        Object.keys(row).length === 2 &&
        (!expected ||
          expected.type === "RECORDING_OPEN" ||
          expected.type === "DOCUMENT_OPEN")
      )
        return { status: "success", opened: true };
      if (
        row.status === "success" &&
        row.downloaded === true &&
        Object.keys(row).length === 2 &&
        expected?.type === "DOCUMENT_DOWNLOAD"
      )
        return { status: "success", downloaded: true };
      const keys = ["courses", ...Object.keys(fields)].filter(
        (key) => key in row,
      );
      const key = keys[0];
      if (
        row.status !== "success" ||
        keys.length !== 1 ||
        !key ||
        Object.keys(row).some(
          (field) =>
            field !== "status" &&
            field !== key &&
            !(key === "recordings" && field === "documentToken"),
        ) ||
        (expected && resultKey[expected.type] !== key)
      )
        throw new Error();
      const raw = row[key];
      if (!Array.isArray(raw) || raw.length > 10000) throw new Error();
      if (key === "courses") {
        const courses: Course[] = raw.map((item: unknown) => {
          if (!item || typeof item !== "object") throw new Error();
          const course = item as Record<string, unknown>;
          if (
            Object.keys(course).length !== 2 ||
            typeof course.name !== "string" ||
            course.name.length > 2000 ||
            redactText(course.name) !== course.name ||
            !validHandle(course.courseSelector)
          )
            throw new Error();
          return { name: course.name, courseSelector: course.courseSelector };
        });
        return { status: "success", courses };
      }
      const schema = fields[key as keyof typeof fields];
      const items = raw.map((item: unknown) => {
        if (!item || typeof item !== "object") throw new Error();
        const data = item as Record<string, unknown>;
        return Object.fromEntries(
          Object.entries(schema)
            .filter(
              ([field, type]) =>
                type !== "optionalUrl" || data[field] !== undefined,
            )
            .map(([field, type]) => {
              const child = data[field];
              if (
                type === "optionalUrl" &&
                typeof child === "string" &&
                itemUrl(child, origin) === child
              )
                return [field, child];
              if (type === "externalTool" && child === "ExternalTool")
                return [field, child];
              if (type === "file" && child === "File") return [field, child];
              if (
                (type === "handle" || type === "optionalHandle") &&
                (validHandle(child) ||
                  (type === "optionalHandle" && child === ""))
              )
                return [field, child];
              if (
                type === "text" &&
                typeof child === "string" &&
                child.length <= 2000
              )
                return [field, redactText(child)];
              if (type === "boolean" && typeof child === "boolean")
                return [field, child];
              if (
                (type === "number" && child === null) ||
                (type === "number" &&
                  typeof child === "number" &&
                  Number.isFinite(child))
              )
                return [field, child];
              if (
                type === "texts" &&
                Array.isArray(child) &&
                child.length <= 50 &&
                child.every((v) => typeof v === "string" && v.length <= 2000)
              )
                return [field, child.map((v) => redactText(v as string))];
              throw new Error();
            }),
        );
      });
      // Every field has been validated against the corresponding closed schema.
      return { status: "success", [key]: items } as Result;
    }
  } catch {
    /* Never expose untrusted response or exception details. */
  }
  return { status: "error", code: "INVALID_RESPONSE" };
}
