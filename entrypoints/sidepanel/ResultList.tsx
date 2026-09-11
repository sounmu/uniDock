import { type Result } from '../../src/protocol';
import { isoTime, type Assignment, type Deadline, type Upcoming, type Todo } from '../../src/domain-items';
function isAssignment(item: Deadline | Upcoming | Todo): item is Assignment { return 'submission_workflow_state' in item; }
export function dateLabel(value: string): string {
  if (!value) return '일정 없음';
  const time = isoTime(value);
  if (!Number.isFinite(time)) return '날짜 확인 필요';
  return new Intl.DateTimeFormat('ko-KR', {dateStyle:'medium', timeStyle:'short', timeZone:'Asia/Seoul'}).format(time);
}
export function ResultList({ result, onCourse }: { result: Extract<Result, {status:'success'}>; onCourse: (name: string) => void }) {
  if ('courses' in result) return <><p className="count">조회 완료 · {result.courses.length}개 과목</p>{result.courses.length === 0 ? <div className="notice">현재 조회 가능한 과목이 없습니다.</div> : <ul>{result.courses.map((course, index) => <li key={index}><div className="item-body"><strong>{course.name}</strong></div><button className="secondary" onClick={() => onCourse(course.name)}>과제 보기</button></li>)}</ul>}</>;
  const items = 'assignments' in result ? result.assignments : 'deadlines' in result ? result.deadlines : 'upcoming' in result ? result.upcoming : result.todo;
  return <><p className="count">조회 완료 · {items.length}개 항목 · 한국 시간</p>{items.length === 0 ? <div className="notice">조회된 항목이 없습니다.</div> : <ul>{items.map((item, index) => <li key={index}><div className="item-body">
    <strong>{item.title || '제목 없음'}</strong>
    {'course' in item && item.course && <p>{item.course}</p>}
    <p>{'date' in item ? '예정' : '마감'} · {dateLabel('date' in item ? item.date : item.due_at)}</p>
    {isAssignment(item) && <p>제출 상태: {item.submission_workflow_state || '정보 없음'}{item.locked_for_user ? ' · 잠김' : ''}{item.missing ? ' · 누락' : ''}{item.late ? ' · 지각 제출' : ''}{!item.published ? ' · 미공개' : ''}</p>}
    {'remaining_candidate' in item && <span className="item-badge">{item.remaining_candidate ? '남은 과제 후보' : '남은 과제 후보 아님'}</span>}
    {'submitted' in item && <span className="item-badge">{item.submitted ? '제출 기록 있음' : '제출 기록 없음'}{item.new_activity ? ' · 새 활동' : ''}</span>}
    {'ignore' in item && <span className="item-badge">{item.ignore ? '숨김 표시됨' : '할 일'}{item.type ? ` · ${item.type}` : ''}</span>}
  </div></li>)}</ul>}</>;
}
