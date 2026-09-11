import { useEffect, useRef, useState } from 'react';
import { isRequest, type ErrorCode, type Request, type ListRequest, type Result } from '../../src/protocol';
import { queryActive } from '../../src/transport';
import { ResultList } from './ResultList';
const messages: Record<ErrorCode, string> = {
  LOGIN_REQUIRED: 'LMS 로그인이 필요합니다. LMS에서 로그인한 뒤 다시 조회하세요.',
  OPEN_LMS: '로그인한 LMS 탭을 선택한 뒤 조회하세요.',
  RELOAD_TAB: 'LMS 탭을 새로고침한 뒤 다시 조회하세요. 확장 설치 직후에는 새로고침이 필요합니다.',
  FORBIDDEN: '조회 권한이 없거나 세션이 만료되었습니다. LMS에서 로그인 상태를 확인하세요.',
  NETWORK: 'LMS에 연결하지 못했습니다. 잠시 후 다시 시도하세요.',
  TIMEOUT: '조회 시간이 초과되었습니다. 다시 시도하세요.',
  INVALID_RESPONSE: 'LMS 응답 형식이 예상과 다릅니다.',
  POLICY: '입력 또는 응답이 안전 정책에 맞지 않아 조회를 중단했습니다.',
  LIMIT: '페이지 수 제한 또는 반복 링크로 조회를 중단했습니다.',
  COURSE_NOT_FOUND: '일치하는 과목이 없습니다. 내 과목에서 과목명을 확인하세요.',
  COURSE_AMBIGUOUS: '여러 과목이 일치합니다. 전체 과목명을 입력하세요. 이름이 같은 과목은 현재 구분할 수 없습니다.',
  STALE_SELECTION: '선택이 만료되었거나 이미 열린 항목입니다. 녹화 목록을 다시 조회하세요.',
  TAB_OPEN_FAILED: '새 탭을 열지 못했습니다. 목록을 다시 조회한 뒤 시도하세요.',
  BUSY: '이전 조회를 처리하고 있습니다. 잠시 후 다시 조회하세요.',
};
const tabs = [ ['COURSES_LIST', '내 과목'], ['ASSIGNMENTS_LIST', '과제'], ['DEADLINES_LIST', '마감일'], ['UPCOMING_LIST', 'Upcoming'], ['TODO_LIST', 'Todo'], ['RECORDINGS_LIST', '녹화 강의'] ] as const;
export function App() {
  const [view, setView] = useState<ListRequest['type']>('COURSES_LIST');
  const [course, setCourse] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [state, setState] = useState<Result | { status: 'idle' | 'loading' }>({ status: 'idle' });
  const generation = useRef(0);
  function clear() { generation.current++; setState({ status: 'idle' }); }
  useEffect(() => {
    const reset = () => { generation.current++; setState({ status: 'idle' }); setCourse(''); };
    const update = (_id: number, info: { status?: string }) => { if (info.status === 'loading') reset(); };
    chrome.tabs.onActivated.addListener(reset);
    chrome.tabs.onUpdated.addListener(update);
    return () => { chrome.tabs.onActivated.removeListener(reset); chrome.tabs.onUpdated.removeListener(update); generation.current++; };
  }, []);
  async function load(query: Request) {
    const current = ++generation.current;
    setState({ status: 'loading' });
    const result = await queryActive(query);
    if (current === generation.current) setState(result);
  }
  const needsCourse = view === 'ASSIGNMENTS_LIST' || view === 'DEADLINES_LIST' || view === 'RECORDINGS_LIST';
  const query: Request = needsCourse ? {version:1,type:view,course} : view === 'UPCOMING_LIST'
    ? {version:1,type:view,...(start ? {start_date:start} : {}),...(end ? {end_date:end} : {})} : {version:1,type:view};
  return <main>
    <header><span className="mark" aria-hidden="true">u</span><div><h1>uniDock</h1><p>고려대학교 LMS</p></div><span className="badge">읽기 전용</span></header>
    <section className="intro"><span className="eyebrow">MY CAMPUS</span><h2>오늘의 배움,<br/>한곳에서.</h2><p>과제와 일정을 기존 LMS 세션으로 확인하세요.</p></section>
    <nav className="views" aria-label="조회 기능">{tabs.map(([type, label]) => <button key={type} aria-pressed={view === type} onClick={() => {clear();setView(type);}}>{label}</button>)}</nav>
    {needsCourse && <label className="field">과목명<input value={course} maxLength={2000} placeholder="전체 과목명 또는 일부" onChange={event => {clear();setCourse(event.target.value);}}/><small>내 과목의 ‘과제 보기’로도 선택할 수 있습니다.</small></label>}
    {view === 'UPCOMING_LIST' && <div className="date-fields"><label className="field">시작일 (선택)<input type="date" value={start} onChange={event => {clear();setStart(event.target.value);}}/></label><label className="field">종료일 (선택)<input type="date" value={end} onChange={event => {clear();setEnd(event.target.value);}}/></label></div>}
    {view === 'UPCOMING_LIST' && start && end && start > end && <p className="filter-error">종료일은 시작일 이후여야 합니다.</p>}
    <div className="toolbar"><h3>{tabs.find(([type]) => type === view)?.[1]}</h3><button onClick={() => void load(query)} disabled={state.status === 'loading' || !isRequest(query)}>{state.status === 'loading' ? '조회 중…' : '조회'}</button></div>
    {view === 'RECORDINGS_LIST' && <p className="hint">외부 도구 항목 중 녹화 강의 후보를 표시합니다. LTI 탭은 LMS를 거쳐 열립니다. 재생은 열린 LMS에서 직접 조작하세요. LMS 자체 재생으로 시청·출석 기록이 반영될 수 있습니다.</p>}
    {view === 'DEADLINES_LIST' && <p className="hint">모든 과제를 표시합니다. ‘남은 후보’는 미제출·잠금 해제·미래 마감 기준이며 실제 제출 가능 여부는 LMS에서 확인하세요.</p>}
    <section aria-live="polite" aria-busy={state.status === 'loading'}>
      {state.status === 'idle' && <div className="notice"><strong>조회할 준비가 되었나요?</strong><p>LMS 탭을 선택하고 조회를 누르세요.</p></div>}
      {state.status === 'loading' && <div className="notice">목록을 불러오고 있습니다…</div>}
      {state.status === 'error' && <div className="notice error"><strong>{state.code === 'LOGIN_REQUIRED' ? '로그인 필요' : '조회 안내'}</strong><p>{messages[state.code]}</p></div>}
      {state.status === 'success' && <ResultList result={state} onRecordings={name => {setCourse(name);setView('RECORDINGS_LIST');void load({version:1,type:'RECORDINGS_LIST',course:name});}} onRecording={handle => {void load({version:1,type:'RECORDING_OPEN',handle});}} onCourse={name => {setCourse(name);setView('ASSIGNMENTS_LIST');void load({version:1,type:'ASSIGNMENTS_LIST',course:name});}}/>}
    </section>
    <a className="lms-link" href="https://mylms.korea.ac.kr/" target="_blank" rel="noreferrer">LMS 열기 ↗</a>
    <footer>기존 로그인 세션만 사용합니다.<br/>로그인 정보와 조회 결과를 저장하지 않습니다.</footer>
  </main>;
}
