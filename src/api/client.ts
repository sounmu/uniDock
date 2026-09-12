import { readJsonBounded } from "./body";
import { NavigationCatalog, type RecordingTarget } from "../navigation-catalog";
import {
  accessible,
  availabilitySnapshot,
  internalId,
  recordingCandidate,
  recordingLabel,
} from "../recordings";
import { projectCourses } from "../domain";
import {
  projectAssignments,
  projectDeadlines,
  projectUpcoming,
  projectTodo,
  rows,
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
      case "TODO_LIST":
        return {
          status: "success",
          todo: await collect(
            "/api/v1/users/self/todo?per_page=100",
            "/api/v1/users/self/todo",
            projectTodo,
          ),
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
            projectUpcoming,
          ),
        };
      }
      case "RECORDING_OPEN":
        throw new Error("POLICY");
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
          // Project each module separately so completion order cannot reorder the UI.
          const targetsByModule: RecordingTarget[][] = Array.from(
            { length: modules.length },
            () => [],
          );
          let nextModule = 0,
            totalTargets = 0;
          let failure: { error: unknown } | undefined;
          async function worker() {
            while (nextModule < modules.length && !controller.signal.aborted) {
              const index = nextModule++;
              const module = modules[index]!;
              try {
                if (!accessible(module, now)) continue;
                const targets = targetsByModule[index]!;
                let items = Array.isArray(module.items) ? module.items : [];
                if (
                  module.items_count != null &&
                  (!Number.isSafeInteger(module.items_count) ||
                    Number(module.items_count) < 0)
                )
                  throw new Error("INVALID_RESPONSE");
                if (
                  Number(module.items_count) > items.length ||
                  (module.items == null && module.items_count !== 0)
                ) {
                  const moduleId = internalId(module.id);
                  if (!moduleId) throw new Error("INVALID_RESPONSE");
                  const itemPath = `${path}/${moduleId}/items`;
                  items = await collect(
                    `${itemPath}?per_page=100&include[]=content_details`,
                    itemPath,
                    rows,
                  );
                }
                if (items.length > 10000) throw new Error("LIMIT");
                for (const item of items.flatMap((item) => rows([item]))) {
                  if (!recordingCandidate(item, now)) continue;
                  const itemId = internalId(item.id);
                  targets.push({
                    module: recordingLabel(module.name),
                    title: recordingLabel(item.title),
                    courseId,
                    itemId,
                    moduleAccess: availabilitySnapshot(module),
                    itemAccess: availabilitySnapshot(item),
                  });
                  if (++totalTargets > 10000) throw new Error("LIMIT");
                }
              } catch (error) {
                // Preserve the original failure instead of reporting sibling aborts as timeouts.
                failure ??= { error };
                controller.abort();
              }
            }
          }
          await Promise.all(
            Array.from({ length: Math.min(3, modules.length) }, () => worker()),
          );
          if (failure) throw failure.error;
          if (controller.signal.aborted) throw new Error("TIMEOUT");
          return {
            status: "success",
            recordings: catalog.replace(origin, targetsByModule.flat()),
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
