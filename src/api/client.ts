import { readJsonBounded } from "./body";
import { NavigationCatalog } from "../navigation-catalog";
import { projectCourseIndex, type InternalCourse } from "../domain";
import {
  projectAssignments,
  projectCourseTodo,
  projectDeadlines,
  projectUpcoming,
  rows,
  type Todo,
} from "../domain-items";
import {
  errors,
  isRequest,
  type ErrorCode,
  type Request,
  type Result,
} from "../protocol";
import { readUrl } from "../security/policy";
import { nextPage } from "./pagination";
import { collectRecordings } from "./recording-collection";
import { collectDocuments } from "./document-collection";
const coursesPath = "/api/v1/courses";
const coursesQuery = `${coursesPath}?per_page=100&enrollment_state=active`;
export async function listQuery(
  origin: string,
  query: Request,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
  catalog?: NavigationCatalog,
  resolvedCourseId?: string,
): Promise<Result> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 20000);
  // One budget covers course resolution plus all item pages.
  let pages = 0;
  // `optional` marks a supplementary source: a first page the LMS refuses
  // (disabled tab, no permission, missing) yields no rows instead of failing
  // the whole list. Redirects, later pages and other errors stay fatal.
  async function collect<T>(
    initial: string,
    path: string,
    project: (raw: unknown) => T[],
    optional = false,
  ): Promise<T[]> {
    let next: string | null = readUrl(initial, origin, path).href;
    const visited = new Set<string>();
    const items: T[] = [];
    while (next) {
      if (controller.signal.aborted) throw new Error("TIMEOUT");
      if (visited.has(next) || pages++ >= 100) throw new Error("LIMIT");
      visited.add(next);
      const response = await fetcher(readUrl(next, origin, path).href, {
        method: "GET",
        credentials: "same-origin",
        redirect: "manual",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      if (
        optional &&
        visited.size === 1 &&
        [401, 403, 404].includes(response.status)
      ) {
        void response.body?.cancel().catch(() => {});
        return [];
      }
      if (
        response.type === "opaqueredirect" ||
        response.status === 401 ||
        (response.status >= 300 && response.status < 400)
      )
        throw new Error("LOGIN_REQUIRED");
      if (response.status === 403) throw new Error("FORBIDDEN");
      if (!response.ok) throw new Error("NETWORK");
      const type = response.headers.get("content-type") ?? "";
      if (type.includes("text/html")) throw new Error("LOGIN_REQUIRED");
      if (!/^application\/json\b/i.test(type))
        throw new Error("INVALID_RESPONSE");
      const raw = await readJsonBounded(response);
      if (controller.signal.aborted) throw new Error("TIMEOUT");
      items.push(...project(raw));
      if (items.length > 10000) throw new Error("LIMIT");
      next = nextPage(response.headers.get("link"), origin, path);
    }
    return items;
  }
  try {
    if (!isRequest(query)) throw new Error("POLICY");
    if (query.type === "RECORDINGS_LIST" || query.type === "DOCUMENTS_LIST")
      catalog?.clear();
    switch (query.type) {
      case "COURSES_LIST":
        throw new Error("POLICY");
      case "UPCOMING_LIST": {
        const params = new URLSearchParams({ per_page: "100" });
        if (query.start_date) params.set("start_date", query.start_date);
        if (query.end_date) params.set("end_date", query.end_date);
        return {
          status: "success",
          upcoming: await collect(
            `/api/v1/planner/items?${params}`,
            "/api/v1/planner/items",
            (raw) => projectUpcoming(raw, origin),
          ),
        };
      }
      case "RECORDING_OPEN":
      case "DOCUMENT_OPEN":
      case "DOCUMENT_DOWNLOAD":
        throw new Error("POLICY");
      case "TODO_LIST":
      case "RECORDINGS_LIST":
      case "DOCUMENTS_LIST":
      case "ASSIGNMENTS_LIST":
      case "DEADLINES_LIST": {
        // Internal IDs live only inside this call, never in panel messages or storage.
        const courses = resolvedCourseId
          ? []
          : await collect(coursesQuery, coursesPath, projectCourseIndex);
        if (query.type === "TODO_LIST") {
          const todo: Todo[] = [];
          for (const course of courses) {
            const path = `/api/v1/courses/${course.id}/assignments`;
            todo.push(
              ...(await collect(
                `${path}?per_page=100&include[]=submission`,
                path,
                (raw) => projectCourseTodo(raw, course.name, origin),
              )),
            );
            if (todo.length > 10000) throw new Error("LIMIT");
          }
          return { status: "success", todo };
        }
        const search = query.course?.trim().toLowerCase();
        const matches = search
          ? courses.filter((course) =>
              course.name.toLowerCase().includes(search),
            )
          : [];
        const exact = search
          ? matches.filter((course) => course.name.toLowerCase() === search)
          : [];
        const match = resolvedCourseId
          ? { id: resolvedCourseId, name: "" }
          : matches.length === 1
            ? matches[0]
            : exact.length === 1
              ? exact[0]
              : undefined;
        if (!match)
          throw new Error(
            matches.length ? "COURSE_AMBIGUOUS" : "COURSE_NOT_FOUND",
          );
        if (
          query.type === "RECORDINGS_LIST" ||
          query.type === "DOCUMENTS_LIST"
        ) {
          if (!catalog) throw new Error("POLICY");
          catalog.clear();
          const courseId = match.id;
          const path = `/api/v1/courses/${courseId}/modules`;
          const modules = await collect(
            `${path}?per_page=100&include[]=items&include[]=content_details`,
            path,
            rows,
          );
          const input = {
            origin,
            courseId,
            path,
            modules,
            collect,
            catalog,
            now,
            controller,
          };
          return query.type === "DOCUMENTS_LIST"
            ? { status: "success", documents: await collectDocuments(input) }
            : { status: "success", recordings: await collectRecordings(input) };
        }
        const path = `/api/v1/courses/${match.id}/assignments`;
        const assignments = await collect(
          `${path}?per_page=100&include[]=submission`,
          path,
          (raw) => projectAssignments(raw, now),
        );
        return query.type === "ASSIGNMENTS_LIST"
          ? { status: "success", assignments }
          : { status: "success", deadlines: projectDeadlines(assignments) };
      }
    }
  } catch (error) {
    const code: ErrorCode = timedOut
      ? "TIMEOUT"
      : error instanceof Error && errors.includes(error.message as ErrorCode)
        ? (error.message as ErrorCode)
        : "NETWORK";
    return { status: "error", code };
  } finally {
    controller.abort();
    clearTimeout(timer);
  }
}
export function listCourses(
  origin: string,
  fetcher: typeof fetch = fetch,
): Promise<
  | { status: "success"; courses: { name: string }[] }
  | { status: "error"; code: ErrorCode }
> {
  return collectCourseIndex(origin, fetcher, false).then((result) =>
    result.status === "success"
      ? {
          status: "success",
          courses: result.courses.map(({ name }) => ({ name })),
        }
      : result,
  );
}

export async function listCourseIndex(
  origin: string,
  fetcher: typeof fetch = fetch,
): Promise<
  | { status: "success"; courses: InternalCourse[] }
  | { status: "error"; code: ErrorCode }
> {
  return collectCourseIndex(origin, fetcher);
}

async function collectCourseIndex(
  origin: string,
  fetcher: typeof fetch,
  includeUnnamed = true,
): Promise<
  | { status: "success"; courses: InternalCourse[] }
  | { status: "error"; code: ErrorCode }
> {
  // Reuse the fully bounded query executor without making COURSES_LIST a
  // public ID-bearing Result.
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 20000);
  let pages = 0;
  try {
    let next: string | null = readUrl(coursesQuery, origin, coursesPath).href;
    const visited = new Set<string>();
    const courses: InternalCourse[] = [];
    while (next) {
      if (controller.signal.aborted) throw new Error("TIMEOUT");
      if (visited.has(next) || pages++ >= 100) throw new Error("LIMIT");
      visited.add(next);
      const response = await fetcher(readUrl(next, origin, coursesPath).href, {
        method: "GET",
        credentials: "same-origin",
        redirect: "manual",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      if (
        response.type === "opaqueredirect" ||
        response.status === 401 ||
        (response.status >= 300 && response.status < 400)
      )
        throw new Error("LOGIN_REQUIRED");
      if (response.status === 403) throw new Error("FORBIDDEN");
      if (!response.ok) throw new Error("NETWORK");
      const type = response.headers.get("content-type") ?? "";
      if (type.includes("text/html")) throw new Error("LOGIN_REQUIRED");
      if (!/^application\/json\b/i.test(type))
        throw new Error("INVALID_RESPONSE");
      const raw = await readJsonBounded(response);
      courses.push(
        ...projectCourseIndex(
          includeUnnamed && Array.isArray(raw)
            ? raw
            : Array.isArray(raw)
              ? raw.filter(
                  (item) =>
                    item !== null &&
                    typeof item === "object" &&
                    (item as Record<string, unknown>).name !== undefined,
                )
              : raw,
        ),
      );
      if (courses.length > 10000) throw new Error("LIMIT");
      next = nextPage(response.headers.get("link"), origin, coursesPath);
    }
    return { status: "success", courses };
  } catch (error) {
    const code: ErrorCode = timedOut
      ? "TIMEOUT"
      : error instanceof Error && errors.includes(error.message as ErrorCode)
        ? (error.message as ErrorCode)
        : "NETWORK";
    return { status: "error", code };
  } finally {
    controller.abort();
    clearTimeout(timer);
  }
}
