import { useEffect, useRef, useState } from 'react';
import { detectCaptions, type CaptionResult } from '../../src/captions/service';
import { downloadCaption } from '../../src/captions/download';
const messages = {
  ACTIVATE_TAB:'강의 플레이어 탭을 선택하고 도구 모음의 uniDock 아이콘을 누른 뒤 다시 감지하세요.',
  NO_KOREAN_CAPTIONS:'로드된 공식 한국어 자막을 찾지 못했습니다. 플레이어에서 한국어 자막/스크립트를 직접 연 뒤 다시 감지하세요.',
  UNSAFE_CAPTION:'접근이 제한되었거나 안전하게 저장할 수 있는 자막이 없습니다. 플레이어를 별도 탭으로 열어 다시 확인하세요.',
  TIMEOUT:'자막 감지 시간이 초과되었습니다. 잠시 후 다시 시도하세요.',
  RELOAD_TAB:'강의 문서가 변경되었습니다. 현재 강의에서 다시 감지하세요.',
};
export function CaptionsPanel() {
  const [state,setState] = useState<CaptionResult | {status:'idle'|'loading'}>({status:'idle'});
  const [notice,setNotice] = useState(''); const generation = useRef(0);
  useEffect(() => {
    const clear = () => {generation.current++;setState({status:'idle'});setNotice('');};
    chrome.tabs.onActivated.addListener(clear); chrome.tabs.onUpdated.addListener(clear);
    return () => {generation.current++;chrome.tabs.onActivated.removeListener(clear);chrome.tabs.onUpdated.removeListener(clear);};
  },[]);
  useEffect(() => {
    if (state.status !== 'success') return;
    const timer = setTimeout(() => {setState({status:'idle'});setNotice('자막 보관 시간이 만료되었습니다. 다시 감지하세요.');},300000);
    return () => clearTimeout(timer);
  },[state]);
  async function detect() {
    const current = ++generation.current;setState({status:'loading'});setNotice('');
    const result = await detectCaptions(); if (current === generation.current) setState(result);
  }
  return <section>
    <p className="hint">강의 탭에서 uniDock 아이콘을 눌러 임시 접근을 허용하세요. 한국어 자막 트랙과 이미 로드된 플레이어 자막만 읽습니다. 영상 재생은 직접 조작하세요.</p>
    <button disabled={state.status === 'loading'} onClick={() => void detect()}>{state.status === 'loading' ? '감지 중…' : '공식 한국어 자막 감지'}</button>
    <div aria-live="polite" aria-busy={state.status === 'loading'}>
      {state.status === 'error' && <p className="notice">{messages[state.code]}</p>}
      {state.status === 'success' && <><p className="count">한국어 자막 {state.captions.length}개 · 5분 동안 메모리에 보관</p>{state.blocked && <p className="hint">일부 자막 또는 프레임은 접근·검증 제한으로 제외되었습니다.</p>}<ul>{state.captions.map((caption,index) => <li key={index}><div className="item-body"><strong>{caption.label}</strong><p>{caption.text.length.toLocaleString()}자 · {caption.source === 'caption_script_dom' ? '현재 로드된 스크립트 (전체 여부 확인 필요)' : '공식 자막 트랙'}</p><button onClick={() => {try {downloadCaption(caption.text);setNotice('TXT 다운로드를 요청했습니다. 브라우저 다운로드 목록을 확인하세요.');} catch {setNotice('안전 검증에 실패해 다운로드를 중단했습니다.');}}}>TXT 다운로드</button></div></li>)}</ul></>}
      {notice && <p className="hint">{notice}</p>}
    </div>
  </section>;
}
