import { type Course, projectCourses } from './domain';
import { type Assignment, type Deadline, type Upcoming, type Todo, isoTime } from './domain-items';
import { redactText } from './security/redaction';
export const errors = ['LOGIN_REQUIRED', 'OPEN_LMS', 'RELOAD_TAB', 'FORBIDDEN', 'NETWORK', 'TIMEOUT', 'INVALID_RESPONSE', 'POLICY', 'LIMIT', 'COURSE_NOT_FOUND', 'COURSE_AMBIGUOUS', 'BUSY'] as const;
export type ErrorCode = typeof errors[number];
export type Request = { version: 1; type: 'COURSES_LIST' | 'TODO_LIST' }
  | { version: 1; type: 'ASSIGNMENTS_LIST' | 'DEADLINES_LIST'; course: string }
  | { version: 1; type: 'UPCOMING_LIST'; start_date?: string; end_date?: string };
export type Result = { status: 'success'; courses: Course[] }
  | { status: 'success'; assignments: Assignment[] } | { status: 'success'; deadlines: Deadline[] }
  | { status: 'success'; upcoming: Upcoming[] } | { status: 'success'; todo: Todo[] }
  | { status: 'error'; code: ErrorCode };
export const request = { version: 1, type: 'COURSES_LIST' } as const;
export function validDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(isoTime(value));
}
export function isRequest(value: unknown): value is Request {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  if (row.version !== 1) return false;
  const keys = Object.keys(row);
  if (row.type === 'COURSES_LIST' || row.type === 'TODO_LIST') return keys.length === 2;
  if (row.type === 'ASSIGNMENTS_LIST' || row.type === 'DEADLINES_LIST') return keys.length === 3 && typeof row.course === 'string' && row.course.trim().length > 0 && row.course.length <= 2000 && redactText(row.course) === row.course;
  if (row.type === 'UPCOMING_LIST') return keys.every(key => ['version', 'type', 'start_date', 'end_date'].includes(key))
    && (row.start_date === undefined || validDate(row.start_date)) && (row.end_date === undefined || validDate(row.end_date))
    && !(typeof row.start_date === 'string' && typeof row.end_date === 'string' && row.start_date > row.end_date);
  return false;
}
const fields = {
  assignments: { title: 'text', due_at: 'text', remaining_candidate: 'boolean', unlock_at: 'text', lock_at: 'text', points_possible: 'number', published: 'boolean', locked_for_user: 'boolean', submission_workflow_state: 'text', submitted_at: 'text', missing: 'boolean', late: 'boolean', submission_types: 'texts' },
  deadlines: { title: 'text', due_at: 'text', remaining_candidate: 'boolean' },
  upcoming: { title: 'text', date: 'text', type: 'text', course: 'text', submitted: 'boolean', new_activity: 'boolean' },
  todo: { title: 'text', due_at: 'text', type: 'text', course: 'text', ignore: 'boolean' },
} as const;
const resultKey = { COURSES_LIST: 'courses', ASSIGNMENTS_LIST: 'assignments', DEADLINES_LIST: 'deadlines', UPCOMING_LIST: 'upcoming', TODO_LIST: 'todo' } as const;
export function parseResult(value: unknown, expected?: Request): Result {
  try {
    if (value && typeof value === 'object') {
      const row = value as Record<string, unknown>;
      if (row.status === 'error' && errors.includes(row.code as ErrorCode)) return { status: 'error', code: row.code as ErrorCode };
      const keys = ['courses', ...Object.keys(fields)].filter(key => key in row);
      const key = keys[0];
      if (row.status !== 'success' || keys.length !== 1 || !key || (expected && resultKey[expected.type] !== key)) throw new Error();
      const raw = row[key];
      if (!Array.isArray(raw) || raw.length > 10000) throw new Error();
      if (key === 'courses') {
        const courses: Course[] = [];
        for (let i = 0; i < raw.length; i += 1000) courses.push(...projectCourses(raw.slice(i, i + 1000)));
        return { status: 'success', courses };
      }
      const schema = fields[key as keyof typeof fields];
      const items = raw.map((item: unknown) => {
        if (!item || typeof item !== 'object') throw new Error();
        const data = item as Record<string, unknown>;
        return Object.fromEntries(Object.entries(schema).map(([field, type]) => {
          const child = data[field];
          if (type === 'text' && typeof child === 'string' && child.length <= 2000) return [field, redactText(child)];
          if (type === 'boolean' && typeof child === 'boolean') return [field, child];
          if (type === 'number' && (child === null || (typeof child === 'number' && Number.isFinite(child)))) return [field, child];
          if (type === 'texts' && Array.isArray(child) && child.length <= 50 && child.every(v => typeof v === 'string' && v.length <= 2000)) return [field, child.map(v => redactText(v as string))];
          throw new Error();
        }));
      });
      // Every field has been validated against the corresponding closed schema.
      return { status: 'success', [key]: items } as Result;
    }
  } catch { /* Never expose untrusted response or exception details. */ }
  return { status: 'error', code: 'INVALID_RESPONSE' };
}
