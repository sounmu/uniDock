import { useEffect, useRef, useState } from 'react';
import { detectCaptions, type CaptionResult } from '../../src/captions/service';
import { downloadCaption } from '../../src/captions/download';
const messages = {
  ACTIVATE_TAB:'강의 플레이어 탭을 선택하고 도구 모음의 uniDock 아이콘을 누른 뒤 다시 감지하세요.',
  NO_CAPTIONS:'화면 자막이나 플레이어 자막 파일을 찾지 못했습니다. 강의 플레이어가 열린 상태인지 확인하세요.',
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
    <p className="hint">강의 탭에서 uniDock 아이콘을 눌러 임시 접근을 허용하세요. 감지를 누르면 화면의 자막 목록을 먼저 읽고, 없으면 KU 플레이어의 XML·VTT 자막 파일을 조회하고, 별도 TXT 스크립트도 확인합니다. 다운로드를 누르면 시간과 문장을 다운로드 폴더의 output/ 아래 TXT·JSON 두 파일로 저장합니다. JSON에는 강의 URL과 제목도 포함됩니다. 개발자 서버로 전송하지 않습니다. 영상 재생은 직접 조작하세요.</p>
    <button disabled={state.status === 'loading'} onClick={() => void detect()}>{state.status === 'loading' ? '감지 중…' : '자막 감지'}</button>
    <div aria-live="polite" aria-busy={state.status === 'loading'}>
      {state.status === 'error' && <p className="notice">{messages[state.code]}</p>}
      {state.status === 'success' && <><p className="count">자막 {state.captions.length}개 · 5분 동안 메모리에 보관</p>{state.blocked && <p className="hint">일부 자막 또는 프레임은 접근·검증 제한으로 제외되었습니다.</p>}<ul>{state.captions.map((caption,index) => <li key={index}><div className="item-body"><strong>{caption.label}</strong><p>{caption.itemCount.toLocaleString()}개 문장 · {caption.source === 'caption_script_dom' ? '현재 로드된 스크립트 (전체 여부 확인 필요)' : caption.source === 'player_media_script' ? '원본 스크립트 · 표기 시각은 영상 재생 위치와 다를 수 있음' : '공식 자막 트랙'}</p><button onClick={() => {void downloadCaption(caption).then(() => setNotice('output/에 TXT·JSON 다운로드를 요청했습니다. 브라우저 다운로드 목록을 확인하세요.')).catch(() => setNotice('다운로드 요청에 실패했습니다. 일부 파일만 저장되었을 수 있으니 다운로드 목록을 확인하세요.'));}}>TXT·JSON 다운로드</button></div></li>)}</ul></>}
      {notice && <p className="hint">{notice}</p>}
    </div>
  </section>;
}
