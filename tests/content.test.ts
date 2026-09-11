import { afterEach, expect, it, vi } from 'vitest';
import { request, type Request } from '../src/protocol';
const list = vi.hoisted(() => vi.fn());
const query = vi.hoisted(() => vi.fn());
vi.mock('../src/api/client', () => ({listCourses:list,listQuery:query}));
vi.mock('wxt/utils/define-content-script', () => ({defineContentScript:(options: unknown) => options}));
import content from '../entrypoints/lms.content';
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
it('rejects forged senders and unsupported actions; coalesces authorized requests', async () => {
  const addListener = vi.fn();
  vi.stubGlobal('chrome', {runtime:{id:'fixture-extension',getURL:()=>'chrome-extension://fixture-extension/sidepanel.html',onMessage:{addListener}}});
  vi.stubGlobal('location',{href:'https://mylms.korea.ac.kr/',origin:'https://mylms.korea.ac.kr'});
  (content as unknown as {main:()=>void}).main();
  const listener = addListener.mock.calls[0]![0];
  const sender = {id:'fixture-extension',url:'chrome-extension://fixture-extension/sidepanel.html'};
  expect(listener(request,{...sender,id:'foreign'},vi.fn())).toBe(false);
  expect(listener(request,{...sender,url:'https://mylms.korea.ac.kr/'},vi.fn())).toBe(false);
  expect(listener({...request,type:'UPLOAD'},sender,vi.fn())).toBe(false);
  expect(list).not.toHaveBeenCalled();
  list.mockResolvedValue({status:'success',courses:[]});
  const respond = vi.fn();
  expect(listener(request,sender,respond)).toBe(true);
  expect(listener(request,sender,respond)).toBe(true);
  await vi.waitFor(() => expect(respond).toHaveBeenCalledTimes(2));
  expect(list).toHaveBeenCalledTimes(1);
});

it.each<Request>([
  {version:1,type:'ASSIGNMENTS_LIST',course:'국제법'},
  {version:1,type:'DEADLINES_LIST',course:'국제법'},
  {version:1,type:'UPCOMING_LIST',start_date:'2026-09-01'},
  {version:1,type:'TODO_LIST'},
])('routes supported read request %j and rejects overlapping different requests', async request => {
  const addListener = vi.fn();
  vi.stubGlobal('chrome', {runtime:{id:'fixture-extension',getURL:()=>'chrome-extension://fixture-extension/sidepanel.html',onMessage:{addListener}}});
  vi.stubGlobal('location',{href:'https://mylms.korea.ac.kr/',origin:'https://mylms.korea.ac.kr'});
  (content as unknown as {main:()=>void}).main();
  const listener = addListener.mock.calls[0]![0];
  const sender = {id:'fixture-extension',url:'chrome-extension://fixture-extension/sidepanel.html'};
  query.mockResolvedValue({status:'error',code:'LOGIN_REQUIRED'});
  const respond = vi.fn(), busy = vi.fn();
  expect(listener(request,sender,respond)).toBe(true);
  listener({version:1,type:'COURSES_LIST'},sender,busy);
  expect(busy).toHaveBeenCalledWith({status:'error',code:'BUSY'});
  await vi.waitFor(() => expect(respond).toHaveBeenCalledWith({status:'error',code:'LOGIN_REQUIRED'}));
  expect(query).toHaveBeenCalledWith('https://mylms.korea.ac.kr',request);
});
