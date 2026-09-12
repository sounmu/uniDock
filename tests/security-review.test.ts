import { afterEach, expect, it, vi } from 'vitest';
import { readJsonBounded } from '../src/api/body';
import { collectCaptionSources } from '../src/captions/extract';
import { detectCaptions } from '../src/captions/service';
afterEach(() => {vi.unstubAllGlobals();vi.useRealTimers();});
it('rejects declared and streamed oversized API responses', async () => {
  await expect(readJsonBounded(new Response('[]',{headers:{'content-length':'500'}}),10)).rejects.toThrow('LIMIT');
  await expect(readJsonBounded(new Response(' '.repeat(100)),10)).rejects.toThrow('LIMIT');
  expect(await readJsonBounded(new Response('[{"name":"과목"}]'))).toEqual([{name:'과목'}]);
});
it('does not continue MAIN inspection after caption timeout', async () => {
  vi.useFakeTimers();
  let finish: (value: unknown) => void = () => {};
  const executeScript = vi.fn().mockReturnValue(new Promise(resolve => {finish=resolve;}));
  vi.stubGlobal('chrome',{tabs:{query:vi.fn().mockResolvedValue([{id:1,url:'https://mylms.korea.ac.kr/player'}])},scripting:{executeScript}});
  const pending=detectCaptions();await vi.advanceTimersByTimeAsync(15000);
  expect(await pending).toEqual({status:'error',code:'TIMEOUT'});
  finish([{documentId:'old',result:{tracks:[]}}]);await Promise.resolve();await Promise.resolve();
  expect(executeScript).toHaveBeenCalledTimes(1);
});
it('rejects non-caption GET endpoints declared as tracks', async () => {
  const track={kind:'captions',srclang:'ko',label:'한국어',src:'https://mylms.korea.ac.kr/logout',getAttribute:()=>'/logout',track:{cues:null}};
  const doc={querySelectorAll:(selector:string)=>selector==='video track, audio track'?[track]:[]};
  vi.stubGlobal('window',{document:doc,location:{origin:'https://mylms.korea.ac.kr'}});vi.stubGlobal('location',{origin:'https://mylms.korea.ac.kr'});
  const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
  expect((await collectCaptionSources('dom')).blocked).toBe(true);expect(fetcher).not.toHaveBeenCalled();
});
it('never invokes nested caption accessors', async () => {
  const getter=vi.fn();const row={label:'한국어',lang:'ko'};Object.defineProperty(row,'caption',{get:getter});
  const doc={querySelectorAll:()=>[]};
  vi.stubGlobal('window',{document:doc,location:{origin:'https://mylms.korea.ac.kr'},captionScriptList:[row]});vi.stubGlobal('location',{origin:'https://mylms.korea.ac.kr'});
  expect((await collectCaptionSources('player')).tracks).toEqual([]);expect(getter).not.toHaveBeenCalled();
});
