// Historical Python text-only conversion contract; not used by the transcript export path.
import { afterEach, expect, it, vi } from 'vitest';
import { captionToText, isKorean, normalizeCaptions } from '../src/captions/normalize';
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
it('matches regenerated Python Korean caption and TXT contracts', async () => {
  const fixture = (await import('./fixtures/python-captions.json')).default;
  for (const sample of fixture.cases) expect(normalizeCaptions(sample.tracks).captions).toEqual(sample.expected);
});
it('rejects JavaScript disguised as a JSON caption field', () => {
  expect(() => captionToText('{"text":"window.captionScriptList = [];"}')).toThrow('UNSAFE_CAPTION');
});
