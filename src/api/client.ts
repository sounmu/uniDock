import { projectCourses } from '../domain';
import { projectAssignments, projectDeadlines, projectUpcoming, projectTodo, rows } from '../domain-items';
import { errors, isRequest, type ErrorCode, type Request, type Result } from '../protocol';
import { readUrl } from '../security/policy';
import { redactText } from '../security/redaction';
import { nextPage } from './pagination';
const coursesPath = '/api/v1/courses';
const coursesQuery = `${coursesPath}?per_page=100&enrollment_state=active`;
export async function listQuery(origin: string, query: Request, fetcher: typeof fetch = fetch, now = Date.now()): Promise<Result> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  // One budget covers course resolution plus all item pages.
  let pages = 0;
  async function collect<T>(initial: string, path: string, project: (raw: unknown) => T[]): Promise<T[]> {
    let next: string | null = readUrl(initial, origin, path).href;
    const visited = new Set<string>();
    const items: T[] = [];
    while (next) {
      if (visited.has(next) || pages++ >= 100) throw new Error('LIMIT');
      visited.add(next);
      const response = await fetcher(readUrl(next, origin, path).href, {
        method: 'GET', credentials: 'same-origin', redirect: 'manual', cache: 'no-store',
        referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' }, signal: controller.signal,
      });
      if (response.type === 'opaqueredirect' || response.status === 401 || (response.status >= 300 && response.status < 400)) throw new Error('LOGIN_REQUIRED');
      if (response.status === 403) throw new Error('FORBIDDEN');
      if (!response.ok) throw new Error('NETWORK');
      const type = response.headers.get('content-type') ?? '';
      if (type.includes('text/html')) throw new Error('LOGIN_REQUIRED');
      if (!/^application\/json\b/i.test(type)) throw new Error('INVALID_RESPONSE');
      let raw: unknown;
      try { raw = await response.json(); } catch { throw new Error('INVALID_RESPONSE'); }
      items.push(...project(raw));
      if (items.length > 10000) throw new Error('LIMIT');
      next = nextPage(response.headers.get('link'), origin, path);
    }
    return items;
  }
  try {
    if (!isRequest(query)) throw new Error('POLICY');
    switch (query.type) {
      case 'COURSES_LIST': return { status: 'success', courses: await collect(coursesQuery, coursesPath, projectCourses) };
      case 'TODO_LIST': return { status: 'success', todo: await collect('/api/v1/users/self/todo?per_page=100', '/api/v1/users/self/todo', projectTodo) };
      case 'UPCOMING_LIST': {
        const params = new URLSearchParams({ per_page: '100' });
        if (query.start_date) params.set('start_date', query.start_date);
        if (query.end_date) params.set('end_date', query.end_date);
        return { status: 'success', upcoming: await collect(`/api/v1/planner/items?${params}`, '/api/v1/planner/items', projectUpcoming) };
      }
      case 'ASSIGNMENTS_LIST':
      case 'DEADLINES_LIST': {
        // Internal IDs live only inside this call, never in panel messages or storage.
        const courses = await collect(coursesQuery, coursesPath, raw => rows(raw).flatMap(row => {
          if (typeof row.name !== 'string' || row.name.length > 2000 || !(typeof row.id === 'string' || (typeof row.id === 'number' && Number.isSafeInteger(row.id)))) return [];
          const id = String(row.id);
          if (!/^[1-9]\d{0,19}$/.test(id)) return [];
          return [{ id, name: redactText(row.name, [id]).trim() }];
        }));
        const search = query.course.trim().toLowerCase();
        const matches = courses.filter(course => course.name.toLowerCase().includes(search));
        const exact = matches.filter(course => course.name.toLowerCase() === search);
        const match = matches.length === 1 ? matches[0] : exact.length === 1 ? exact[0] : undefined;
        if (!match) throw new Error(matches.length ? 'COURSE_AMBIGUOUS' : 'COURSE_NOT_FOUND');
        const path = `/api/v1/courses/${match.id}/assignments`;
        const assignments = await collect(`${path}?per_page=100&include[]=submission`, path, raw => projectAssignments(raw, now));
        return query.type === 'ASSIGNMENTS_LIST' ? { status: 'success', assignments } : { status: 'success', deadlines: projectDeadlines(assignments) };
      }
    }
  } catch (error) {
    const code: ErrorCode = controller.signal.aborted ? 'TIMEOUT' : error instanceof Error && errors.includes(error.message as ErrorCode) ? error.message as ErrorCode : 'NETWORK';
    return { status: 'error', code };
  } finally { clearTimeout(timer); }
}
export function listCourses(origin: string, fetcher: typeof fetch = fetch): Promise<Result> {
  return listQuery(origin, {version: 1, type: 'COURSES_LIST'}, fetcher);
}
