import { readJsonBounded } from "./body";
import { NavigationCatalog } from "../navigation-catalog";
import { projectCourses } from "../domain";
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
import { redactText } from "../security/redaction";
import { nextPage } from "./pagination";
import { collectRecordings } from "./recording-collection";
const coursesPath = "/api/v1/courses";
const coursesQuery = `${coursesPath}?per_page=100&enrollment_state=active`;
export async function listQuery(
  origin: string,
  query: Request,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
  catalog?: NavigationCatalog,
): Promise<Result> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 20000);
  // One budget covers course resolution plus all item pages.
  let pages = 0;
  async function collect<T>(
    initial: string,
    path: string,
    project: (raw: unknown) => T[],
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
    if (query.type === "RECORDINGS_LIST") catalog?.clear();
    switch (query.type) {
      case "COURSES_LIST":
        return {
          status: "success",
          courses: await collect(coursesQuery, coursesPath, projectCourses),
        };
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
        throw new Error("POLICY");
      case "TODO_LIST":
      case "RECORDINGS_LIST":
      case "ASSIGNMENTS_LIST":
      case "DEADLINES_LIST": {
        // Internal IDs live only inside this call, never in panel messages or storage.
        const courses = await collect(coursesQuery, coursesPath, (raw) =>
          rows(raw).flatMap((row) => {
            if (
              typeof row.name !== "string" ||
              row.name.length > 2000 ||
              !(
                typeof row.id === "string" ||
                (typeof row.id === "number" && Number.isSafeInteger(row.id))
              )
            )
              return [];
            const id = String(row.id);
            if (!/^[1-9]\d{0,19}$/.test(id)) return [];
            return [{ id, name: redactText(row.name, [id]).trim() }];
          }),
        );
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
        const search = query.course.trim().toLowerCase();
        const matches = courses.filter((course) =>
          course.name.toLowerCase().includes(search),
        );
        const exact = matches.filter(
          (course) => course.name.toLowerCase() === search,
        );
        const match =
          matches.length === 1
            ? matches[0]
            : exact.length === 1
              ? exact[0]
              : undefined;
        if (!match)
          throw new Error(
            matches.length ? "COURSE_AMBIGUOUS" : "COURSE_NOT_FOUND",
          );
        if (query.type === "RECORDINGS_LIST") {
          if (!catalog) throw new Error("POLICY");
          catalog.clear();
          const courseId = match.id;
          const path = `/api/v1/courses/${courseId}/modules`;
          const modules = await collect(
            `${path}?per_page=100&include[]=items&include[]=content_details`,
            path,
            rows,
          );
          return {
            status: "success",
            recordings: await collectRecordings({
              origin,
              courseId,
              path,
              modules,
              collect,
              catalog,
              now,
              controller,
            }),
          };
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
): Promise<Result> {
  return listQuery(origin, { version: 1, type: "COURSES_LIST" }, fetcher);
}
