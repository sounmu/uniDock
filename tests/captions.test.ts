import { afterEach, expect, it, vi } from 'vitest';
import { captionToText, isKorean, normalizeCaptions } from '../src/captions/normalize';
import { collectCaptionSources } from '../src/captions/extract';
import { detectCaptions } from '../src/captions/service';
import { downloadCaption } from '../src/captions/download';
const korean = {language:'ko',label:'한국어',source:'track_element',format:'vtt',text:'WEBVTT\n\ncue-1\n00:00:00.000 --> 00:00:02.000\n국제법 자막입니다.\n'};
afterEach(() => {vi.unstubAllGlobals();vi.restoreAllMocks();vi.useRealTimers();});
it.each(['ko','kor','kr','ko-KR','ko_KR','KO','ko-kp'])('accepts Python Korean language %s', value => expect(isKorean(value,'')).toBe(true));
it.each(['한국어','한글4-1','14-1 국문','Korean'])('accepts Python Korean label %s', value => expect(isKorean('',value)).toBe(true));
it.each(['en','zh','ja'])('does not infer Korean from transcript text: %s', value => expect(isKorean(value,'')).toBe(false));
it('matches the Python CLI VTT fixture TXT output', () => expect(captionToText(korean.text)).toBe('국제법 자막입니다.\n'));
it('strips cue ids/timestamps/VTT metadata while preserving dialogue', () => {
  expect(captionToText('WEBVTT\n\nSTYLE\n::cue { color: red }\n\nNOTE metadata\nprivate note\n\n1\n00:00:01,000 --> 00:00:02,000\n<b>안녕</b> &amp; 반가워요\n\n2\n00:00:02,000 --> 00:00:03,000\n다음 문장')).toBe('안녕 & 반가워요\n\n다음 문장\n');
});
it('preserves consecutive repeated cues and single-word dialogue', () => expect(captionToText('WEBVTT\n\ncue-1\n00:00:00.000 --> 00:00:01.000\nYes\n\ncue-2\n00:00:01.000 --> 00:00:02.000\nYes')).toBe('Yes\n\nYes\n'));
it('handles TTML paragraphs and official JSON text fields', () => {
  expect(captionToText('<tt><body><p>안녕하세요 <span>여러분</span></p><p>두 번째</p></body></tt>')).toBe('안녕하세요 여러분\n두 번째\n');
  expect(captionToText('{"cues":[{"start":0,"text":"한국어 자막"}],"url":"https://example.invalid/private"}')).toBe('한국어 자막\n');
});
it.each(['<html>로그인</html>','window.captionScriptList = [];','const x = [];','학생 번호 12345678','토큰 https://example.invalid/private','학생 a@example.invalid','cookie=secret','&lt;script&gt;alert(1)&lt;/script&gt;','WEBVTT\n\n'])('refuses unsafe/empty text %s', value => expect(() => captionToText(value)).toThrow());
it('deduplicates Korean tracks and excludes other languages', () => {
  const output = normalizeCaptions([korean,{...korean,source:'player_caption_api'},{...korean,language:'en',label:'English',text:'English text'}]);
  expect(output.captions).toEqual([{label:'한국어',source:'track_element',text:'국제법 자막입니다.\n'}]);
});
it('does not emit raw metadata and excludes unsafe caption text', () => {
  const output = normalizeCaptions([{...korean,url:'https://example.invalid/token',cookie:'private'},{...korean,text:'token=private'}]);
  expect(output.blocked).toBe(true);
  expect(JSON.stringify(output)).not.toMatch(/example|private|cookie/);
});
it('enforces input bounds', () => {
  expect(() => captionToText('가'.repeat(1000001))).toThrow('LIMIT');
  expect(() => normalizeCaptions(Array(41).fill(korean))).toThrow('LIMIT');
});
function page(tracks: unknown[] = []) {
  const doc = {querySelectorAll:vi.fn((selector: string) => selector === 'video track, audio track' ? tracks : [])};
  const win = {document:doc,location:{origin:'https://mylms.korea.ac.kr',href:'https://mylms.korea.ac.kr/player'}};
  vi.stubGlobal('window',win);vi.stubGlobal('document',doc);vi.stubGlobal('location',win.location);
  return win;
}
it('reads loaded native cues without playing media or fetching', async () => {
  const fetcher = vi.fn();vi.stubGlobal('fetch',fetcher);
  page([{kind:'subtitles',srclang:'ko',label:'한국어',track:{cues:[{text:'공식 자막'}]}}]);
  const result = await collectCaptionSources('dom');
  expect(result.tracks[0]?.text).toBe('공식 자막');
  expect(fetcher).not.toHaveBeenCalled();
});
it('fetches only a declared same-origin track with bounded read-only options', async () => {
  page([{kind:'captions',srclang:'ko',label:'한국어',src:'https://mylms.korea.ac.kr/caption.vtt',getAttribute:()=>'/caption.vtt',track:{cues:null}}]);
  const fetcher = vi.fn().mockResolvedValue(new Response(korean.text,{headers:{'content-type':'text/vtt'}}));vi.stubGlobal('fetch',fetcher);
  const result = await collectCaptionSources('dom');
  expect(result.tracks).toHaveLength(1);
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({method:'GET',credentials:'same-origin',redirect:'manual',cache:'no-store'});
  expect(JSON.stringify(result)).not.toContain('caption.vtt');
});
it('refuses external caption fetch and does not call player getters/methods', async () => {
  const win = page([{kind:'subtitles',srclang:'ko',label:'한국어',src:'https://cdn.example.invalid/caption.vtt',getAttribute:()=>'/caption.vtt',track:{cues:null}}]);
  const fetcher = vi.fn(), getter = vi.fn();vi.stubGlobal('fetch',fetcher);
  Object.defineProperty(win,'captionScriptList',{get:getter});
  expect((await collectCaptionSources('dom')).blocked).toBe(true);
  expect((await collectCaptionSources('player')).tracks).toEqual([]);
  expect(fetcher).not.toHaveBeenCalled();expect(getter).not.toHaveBeenCalled();
});
it('reads only Korean already-loaded player cue data', async () => {
  const win = page();
  Object.assign(win,{captionScriptList:[{label:'한글4-1',lang:'한국어',caption:{cues:[{text:'한국어 자막'}]}},{label:'English',lang:'en',caption:{cues:[{text:'English'}]}}]});
  expect((await collectCaptionSources('player')).tracks).toEqual([{label:'한글4-1',language:'한국어',source:'player_caption_api',format:'txt',text:'한국어 자막'}]);
});
it('binds inspection to active HTTPS tab and same document', async () => {
  const executeScript = vi.fn().mockResolvedValueOnce([{documentId:'doc',result:{tracks:[korean],blocked:false}}]).mockResolvedValueOnce([{documentId:'doc',result:{tracks:[],blocked:false}}]);
  vi.stubGlobal('chrome',{tabs:{query:vi.fn().mockResolvedValue([{id:7,url:'https://player.example.invalid/'}]),get:vi.fn().mockResolvedValue({url:'https://player.example.invalid/'})},scripting:{executeScript}});
  expect(await detectCaptions()).toEqual({status:'success',captions:[{label:'한국어',source:'track_element',text:'국제법 자막입니다.\n'}],blocked:false});
  expect(executeScript.mock.calls[1]?.[0].target).toEqual({tabId:7,documentIds:['doc']});
});
it('reports permission errors without exposing browser exceptions', async () => {
  vi.stubGlobal('chrome',{tabs:{query:vi.fn().mockRejectedValue(new Error('https://private.invalid/?token=secret'))}});
  expect(await detectCaptions()).toEqual({status:'error',code:'ACTIVATE_TAB'});
});
it('downloads only a local UTF-8 Blob with a generic TXT filename', () => {
  vi.useFakeTimers();const click = vi.fn(), remove = vi.fn(), append = vi.fn();
  const anchor = {href:'',download:'',click,remove};
  vi.stubGlobal('document',{createElement:()=>anchor,body:{append}});
  const create = vi.spyOn(URL,'createObjectURL').mockReturnValue('blob:local');
  const revoke = vi.spyOn(URL,'revokeObjectURL').mockImplementation(() => {});
  downloadCaption('한국어 자막\n',new Date('2026-09-11T00:00:00Z'));
  expect(create.mock.calls[0]?.[0]).toBeInstanceOf(Blob);
  expect(anchor.download).toBe('uniDock-ko-20260911T000000Z.txt');expect(click).toHaveBeenCalledOnce();expect(remove).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(1000);expect(revoke).toHaveBeenCalledWith('blob:local');
  expect(() => downloadCaption('token=secret')).toThrow();expect(create).toHaveBeenCalledTimes(1);
});
it('matches regenerated Python Korean caption and TXT contracts', async () => {
  const fixture = (await import('./fixtures/python-captions.json')).default;
  for (const sample of fixture.cases) expect(normalizeCaptions(sample.tracks).captions).toEqual(sample.expected);
});
it('rejects results after the selected document navigates', async () => {
  const executeScript = vi.fn().mockResolvedValueOnce([{documentId:'old',result:{tracks:[korean]}}]).mockResolvedValueOnce([{documentId:'new',result:{tracks:[korean]}}]);
  vi.stubGlobal('chrome',{tabs:{query:vi.fn().mockResolvedValue([{id:7,url:'https://mylms.korea.ac.kr/player'}]),get:vi.fn().mockResolvedValue({url:'https://mylms.korea.ac.kr/login'})},scripting:{executeScript}});
  expect(await detectCaptions()).toEqual({status:'error',code:'RELOAD_TAB'});
});
it('bounds a hanging injection and never downloads automatically', async () => {
  vi.useFakeTimers();
  const executeScript = vi.fn().mockReturnValue(new Promise(() => {}));
  vi.stubGlobal('chrome',{tabs:{query:vi.fn().mockResolvedValue([{id:7,url:'https://mylms.korea.ac.kr/player'}])},scripting:{executeScript}});
  const pending = detectCaptions();await vi.advanceTimersByTimeAsync(15000);
  expect(await pending).toEqual({status:'error',code:'TIMEOUT'});
});
it('rejects JavaScript disguised as a JSON caption field', () => {
  expect(() => captionToText('{"text":"window.captionScriptList = [];"}')).toThrow('UNSAFE_CAPTION');
});
