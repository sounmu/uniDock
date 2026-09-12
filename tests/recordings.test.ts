import { afterEach, expect, it, vi } from 'vitest';
import { accessible, recordingCandidate, recordingLabel } from '../src/recordings';
import { NavigationCatalog } from '../src/navigation-catalog';
import { listQuery } from '../src/api/client';
import { isRequest, parseResult } from '../src/protocol';
import { navigationUrl } from '../src/security/navigation';
import { openLmsTab } from '../src/open-tab';
import { readUrl } from '../src/security/policy';
const origin = 'https://mylms.korea.ac.kr';
const now = Date.parse('2026-09-11T00:00:00Z');
const catalogs: NavigationCatalog[] = [];
const catalog = () => { const value = new NavigationCatalog(); catalogs.push(value); return value; };
const item = (id: number, title = '1차시') => ({id,type:'ExternalTool',title,html_url:'https://lti.example.invalid/launch?token=fixture-secret'});
const json = (body: unknown, link?: string) => new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json',...(link ? {Link:link} : {})}});
afterEach(() => { catalogs.forEach(value => value.clear()); catalogs.length = 0; vi.unstubAllGlobals(); vi.useRealTimers(); });
it.each([{published:false},{locked_for_user:true},{state:'locked'},{unlock_at:'2099-01-01T00:00:00Z'},{lock_at:'2000-01-01T00:00:00Z'},{content_details:{locked_for_user:true}},{content_details:{unlock_at:'2099-01-01T00:00:00Z'}},{unlock_at:'unparseable'},{content_details:'invalid'}])('excludes unavailable metadata %j', metadata => expect(accessible(metadata,now)).toBe(false));
it('respects exact time boundaries and missing availability', () => {
  expect(accessible({},now)).toBe(true);
  expect(accessible({unlock_at:'2026-09-11T00:00:00Z'},now)).toBe(true);
  expect(accessible({lock_at:'2026-09-11T00:00:00Z'},now)).toBe(false);
});
it.each(['[강의 교안] 1주차','강 의 자 료','자료'])('excludes handouts %s', title => expect(recordingCandidate(item(1,title),now)).toBe(false));
it('excludes other item types', () => expect(recordingCandidate({...item(1),type:'ExternalUrl'},now)).toBe(false));
it('discovers module and item pages, replaces truncated inline items, skips locked modules', async () => {
  const store = catalog();
  const fetcher = vi.fn<typeof fetch>(async input => {
    const url = new URL(String(input));
    if (url.pathname === '/api/v1/courses') return json([{id:101,name:'과목'}]);
    if (url.pathname.endsWith('/modules') && !url.searchParams.has('page')) return json([{id:10,name:'1주차',items_count:2,items:[item(501,'잘린 중복')]}],`<${origin}/api/v1/courses/101/modules?page=2>; rel="next"`);
    if (url.pathname.endsWith('/modules')) return json([{id:20,name:'잠김 모듈',state:'locked',items_count:9}]);
    if (url.pathname.endsWith('/modules/10/items') && !url.searchParams.has('page')) return json([item(501)],`<${origin}/api/v1/courses/101/modules/10/items?page=2>; rel="next"`);
    return json([item(502,'2차시'),item(503,'교안'),{...item(504),published:false}]);
  });
  const query = {version:1,type:'RECORDINGS_LIST',course:'과목'} as const;
  const result = await listQuery(origin,query,fetcher,now,store);
  expect(result.status).toBe('success');
  if (result.status !== 'success' || !('recordings' in result)) throw new Error('Missing list');
  expect(result.recordings.map(row => row.title)).toEqual(['1차시','2차시']);
  expect(parseResult(result,query)).toEqual(result);
  expect(JSON.stringify(result)).not.toMatch(/fixture-secret|html_url|lti\.example|course_id|\/courses\//);
  expect(store.take(result.recordings[0]!.launchHandle,origin)).toBe(`${origin}/courses/101/modules/items/501`);
  expect(store.take(result.recordings[1]!.lmsHandle,origin)).toBe(`${origin}/courses/101/modules`);
  expect(fetcher).toHaveBeenCalledTimes(5);
  for (const [,options] of fetcher.mock.calls) expect(options?.method).toBe('GET');
});
it('uses LMS-only fallback without an item ID', async () => {
  const store = catalog();
  const fetcher = vi.fn().mockResolvedValueOnce(json([{id:101,name:'과목'}])).mockResolvedValueOnce(json([{name:'모듈',items:[{type:'ExternalTool',title:'강의',html_url:'https://lti.example.invalid/secret'}]}]));
  const result = await listQuery(origin,{version:1,type:'RECORDINGS_LIST',course:'과목'},fetcher,now,store);
  if (result.status !== 'success' || !('recordings' in result)) throw new Error('Missing list');
  expect(result.recordings[0]?.launchHandle).toBe('');
});
it.each(['course','module','item','content'])('preserves dates and lesson numbers matching the %s ID through the public response', async collision => {
  const store = catalog();
  const title = '[26.09.03] 2. Image Formation';
  const moduleName = '2026년 2주차';
  const courseId = collision === 'course' ? 2 : 2026;
  const itemId = collision === 'item' ? 2 : 903;
  const fetcher = vi.fn().mockResolvedValueOnce(json([{id:courseId,name:'과목'}]))
    .mockResolvedValueOnce(json([{id:collision === 'module' ? 2 : 26,name:moduleName,
      items:[{...item(itemId,title),content_id:collision === 'content' ? 2 : 3}]}]));
  const query = {version:1,type:'RECORDINGS_LIST',course:'과목'} as const;
  const result = parseResult(await listQuery(origin,query,fetcher,now,store),query);
  if (result.status !== 'success' || !('recordings' in result)) throw new Error('Missing list');
  expect(result.recordings).toEqual([{module:moduleName,title,type:'ExternalTool',
    lmsHandle:expect.any(String),launchHandle:expect.any(String)}]);
  expect(store.take(result.recordings[0]!.launchHandle,origin)).toBe(`${origin}/courses/${courseId}/modules/items/${itemId}`);
});
it.each(['https://example.invalid/launch?token=secret','a@example.invalid','token=secret','course_id=2','12345678'])('still masks sensitive recording label text: %s', value => {
  expect(recordingLabel(`강의 ${value}`)).toBe('강의 [REDACTED]');
});
it('expires, replaces and consumes handles without deriving them from IDs', () => {
  const store = catalog();
  const target = {module:'week',title:'lecture',courseId:'101',itemId:'501',moduleAccess:{},itemAccess:{}};
  const [one] = store.replace(origin,[target],now);
  expect(store.take(one!.launchHandle,origin,now)).toContain('/items/501');
  expect(store.take(one!.launchHandle,origin,now)).toBeNull();
  expect(store.take(one!.lmsHandle,origin,now+300000)).toBeNull();
  const [two] = store.replace(origin,[target],now);
  store.replace(origin,[],now);
  expect(store.take(two!.launchHandle,origin,now)).toBeNull();
});
it('rechecks known lock time at open', () => {
  const store = catalog();
  const [recording] = store.replace(origin,[{module:'week',title:'lecture',courseId:'101',itemId:'501',moduleAccess:{},itemAccess:{lock_at:'2026-09-11T00:00:01Z'}}],now);
  expect(store.take(recording!.launchHandle,origin,now+1000)).toBeNull();
});
it.each(['https://evil.invalid/courses/101/modules','https://canvas.korea.ac.kr/courses/101/modules',`${origin}/courses/101/modules?token=secret`,`${origin}/courses/101/modules/items/501#secret`,`${origin}/api/v1/courses/101`,`${origin}/courses/101/external_tools/5`,'javascript:alert(1)'])('blocks unsafe navigation %s', value => expect(navigationUrl(value,origin)).toBeNull());
it('allows only module includes and same module pagination', () => {
  expect(readUrl('/api/v1/courses/101/modules?include[]=items&include[]=content_details',origin,'/api/v1/courses/101/modules')).toBeTruthy();
  expect(() => readUrl('/api/v1/courses/101/modules?include[]=submission',origin,'/api/v1/courses/101/modules')).toThrow();
  expect(() => readUrl('/api/v1/courses/101/modules/20/items?page=2',origin,'/api/v1/courses/101/modules/10/items')).toThrow();
});
it('validates open protocol and removes extraneous payloads', () => {
  const handle = crypto.randomUUID();
  expect(isRequest({version:1,type:'RECORDING_OPEN',handle})).toBe(true);
  expect(isRequest({version:1,type:'RECORDING_OPEN',handle,url:origin})).toBe(false);
  expect(isRequest({version:1,type:'RECORDING_OPEN',handle:'101'})).toBe(false);
  expect(parseResult({status:'success',opened:true},{version:1,type:'RECORDING_OPEN',handle})).toEqual({status:'success',opened:true});
  expect(parseResult({status:'success',opened:true},{version:1,type:'COURSES_LIST'}).status).toBe('error');
});
it('opens exactly one canonical foreground tab and suppresses browser details', async () => {
  const create = vi.fn().mockResolvedValue({id:8,url:'private'});
  vi.stubGlobal('chrome',{runtime:{id:'extension'},tabs:{get:vi.fn().mockResolvedValue({url:origin+'/'}),create}});
  const sender = {id:'extension',frameId:0,url:origin+'/',tab:{id:7}} as chrome.runtime.MessageSender;
  const message = {version:1,type:'OPEN_LMS_TARGET',url:origin+'/courses/101/modules/items/501'};
  expect(await openLmsTab(message,sender)).toEqual({status:'success',opened:true});
  expect(create).toHaveBeenCalledExactlyOnceWith({url:message.url,active:true});
  expect(await openLmsTab(message,{...sender,id:'foreign'})).toEqual({status:'error',code:'POLICY'});
  expect(await openLmsTab(message,{...sender,frameId:1})).toEqual({status:'error',code:'POLICY'});
  expect(await openLmsTab({...message,url:'https://evil.invalid/'},sender)).toEqual({status:'error',code:'POLICY'});
  expect(create).toHaveBeenCalledTimes(1);
});

it('matches the original Python recording fixture public projection', async () => {
  const fixture = (await import('./fixtures/python-contract.json')).default;
  const store = catalog();
  const fetcher = vi.fn().mockResolvedValueOnce(json(fixture.raw.courses)).mockResolvedValueOnce(json(fixture.raw.recordings));
  const result = await listQuery(origin,{version:1,type:'RECORDINGS_LIST',course:'국제법'},fetcher,now,store);
  if (result.status !== 'success' || !('recordings' in result)) throw new Error('Missing list');
  expect(result.recordings.map(({module,title,type}) => ({module,title,type,playable:true}))).toEqual(fixture.expected.recordings);
});
