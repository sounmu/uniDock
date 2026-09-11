import { redactText } from './security/redaction';
export interface Deadline { title: string; due_at: string; remaining_candidate: boolean }
export interface Assignment extends Deadline {
  unlock_at: string; lock_at: string; points_possible: number | null; published: boolean;
  locked_for_user: boolean; submission_workflow_state: string; submitted_at: string;
  missing: boolean; late: boolean; submission_types: string[];
}
export interface Upcoming { title: string; date: string; type: string; course: string; submitted: boolean; new_activity: boolean }
export interface Todo { title: string; due_at: string; type: string; course: string; ignore: boolean }
type Row = Record<string, unknown>;
function record(value: unknown): Row { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : {}; }
function text(value: unknown): string {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || value.length > 2000) throw new Error('INVALID_RESPONSE');
  return redactText(value);
}
function privateIds(row: Row): string[] {
  return [row.id, row.course_id, row.user_id].filter(value => typeof value === 'string' || typeof value === 'number').map(String);
}
function label(value: unknown, ...rows: Row[]): string { return redactText(text(value), rows.flatMap(privateIds)); }
export function rows(raw: unknown): Row[] {
  if (!Array.isArray(raw) || raw.length > 1000) throw new Error('INVALID_RESPONSE');
  // Python live projections skip non-dict entries.
  return raw.filter(item => item !== null && typeof item === 'object' && !Array.isArray(item)) as Row[];
}
// Canvas ISO dates; timezone-less values are UTC, as in Python, not browser local time.
export function isoTime(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?(Z|[+-]\d{2}:\d{2})?)?$/.exec(value);
  if (!match) return NaN;
  const [, y, m, d, h = '00', min = '00', sec = '00', fraction = '', zone] = match;
  const date = new Date(0);
  date.setUTCFullYear(Number(y), Number(m) - 1, Number(d));
  date.setUTCHours(Number(h), Number(min), Number(sec), Number(fraction.padEnd(3, '0').slice(0, 3)));
  if (Number(y) < 1 || date.getUTCFullYear() !== Number(y) || date.getUTCMonth() !== Number(m) - 1 || date.getUTCDate() !== Number(d) || Number(h) > 23 || Number(min) > 59 || Number(sec) > 59) return NaN;
  let offset = 0;
  if (zone && zone !== 'Z') {
    const hours = Number(zone.slice(1, 3)), minutes = Number(zone.slice(4));
    if (hours > 23 || minutes > 59) return NaN;
    offset = (hours * 60 + minutes) * 60000 * (zone[0] === '+' ? 1 : -1);
  }
  return date.getTime() - offset + Number(fraction.padEnd(6, '0').slice(3)) / 1000;
}
export function remainingCandidate(due: string, locked: boolean, submitted: string, workflow: string, now = Date.now()): boolean {
  return !locked && !submitted && !['submitted', 'graded'].includes(workflow) && isoTime(due) > now;
}
export function projectAssignments(raw: unknown, now = Date.now()): Assignment[] {
  return rows(raw).map(row => {
    const submission = record(row.submission);
    const due = text(row.due_at), submitted = text(submission.submitted_at), workflow = label(submission.workflow_state, row, submission);
    if (row.points_possible != null && (typeof row.points_possible !== 'number' || !Number.isFinite(row.points_possible))) throw new Error('INVALID_RESPONSE');
    if (row.submission_types != null && (!Array.isArray(row.submission_types) || row.submission_types.length > 50)) throw new Error('INVALID_RESPONSE');
    return {
      title: label(row.name || row.title, row), due_at: due, unlock_at: text(row.unlock_at), lock_at: text(row.lock_at),
      points_possible: row.points_possible as number | undefined ?? null,
      published: row.published === undefined ? true : Boolean(row.published), locked_for_user: Boolean(row.locked_for_user),
      submission_workflow_state: workflow, submitted_at: submitted, missing: Boolean(submission.missing), late: Boolean(submission.late),
      submission_types: ((row.submission_types ?? []) as unknown[]).map(value => label(value, row)),
      remaining_candidate: remainingCandidate(due, Boolean(row.locked_for_user), submitted, workflow, now),
    };
  });
}
export function projectDeadlines(assignments: Assignment[]): Deadline[] {
  return assignments.map(({ title, due_at, remaining_candidate }) => ({ title, due_at, remaining_candidate }));
}
export function projectUpcoming(raw: unknown): Upcoming[] {
  return rows(raw).map(row => {
    const item = record(row.plannable), submission = record(row.submissions);
    return { title: label(item.title || item.name || row.title, row, item), date: text(row.plannable_date || item.due_at),
      type: label(row.plannable_type || item.type, row, item), course: label(row.context_name, row, item),
      submitted: Boolean(submission.submitted || submission.submitted_at), new_activity: Boolean(row.new_activity) };
  });
}
export function projectTodo(raw: unknown): Todo[] {
  return rows(raw).map(row => {
    const item = record(row.assignment);
    return { title: label(item.name || item.title || row.type, row, item), due_at: text(item.due_at),
      type: label(row.type, row, item), course: label(row.context_name, row, item), ignore: Boolean(row.ignore) };
  });
}
