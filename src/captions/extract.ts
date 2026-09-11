/** Self-contained: Chrome serializes this function into the selected tab.
 * DOM world fetches ONLY declared same-origin track sources. MAIN world reads
 * already-loaded captionScriptList values; never calls player methods.
 */
export async function collectCaptionSources(mode: 'dom' | 'player') {
  const out: {label:string;language:string;source:string;format:string;text:string}[] = [];
  let blocked = false, limited = false, frames = 0, bytes = 0;
  const korean = (lang: string, label: string) => /^(ko(?:-|$)|kor$|kr$)/i.test(lang.replaceAll('_','-').trim()) || /korean|한국|한글|국문/i.test(`${lang} ${label}`);
  const plain = (value: unknown): string => typeof value === 'string' ? value : '';
  const sensitive = (text: string) => /https?:\/\/|[\w.%+-]+@[\w.-]+\.[a-z]{2,}|\b\d{8,}\b|(?:token|cookie|password|authorization|saml|oauth|session|course[_ -]?id)\s*[:=]/i.test(text);
  const add = (label: string, language: string, source: string, format: string, text: string) => {
    if (!text.trim() || !korean(language,label)) return;
    if (text.length > 1000000 || bytes + text.length > 2000000 || out.length >= 20) {limited = true; return;}
    if (label.length > 200 || language.length > 100 || sensitive(text.replace(/<[^>]*>/g,'')) || sensitive(label) || sensitive(language)) {blocked = true;return;}
    bytes += text.length;
    out.push({label,language,source,format,text});
  };
  const cueText = (cues: ArrayLike<unknown> | null | undefined): string => {
    if (!cues || cues.length > 20000) {if (cues) limited = true;return '';}
    const values: string[] = [];
    let length = 0;
    for (let i=0;i<cues.length;i++) {
      const cue = cues[i];
      const text = plain(cue && typeof cue === 'object' ? (cue as {text?:unknown}).text : undefined); length += text.length;
      if (length > 1000000) {limited = true;return '';}
      values.push(text);
    }
    return values.join('\n');
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(),10000);
  async function visit(win: Window, depth: number): Promise<void> {
    if (depth > 3 || ++frames > 20) {limited = true;return;}
    let doc: Document;
    try {doc = win.document; if (win.location.origin !== location.origin) {blocked = true;return;}} catch {blocked = true;return;}
    if (mode === 'player') {
      // Own data property avoids executing a getter or calling a player API.
      const descriptor = Object.getOwnPropertyDescriptor(win,'captionScriptList');
      const list: unknown = descriptor && 'value' in descriptor ? descriptor.value : undefined;
      if (Array.isArray(list)) {
        if (list.length > 20) limited = true;
        for (const row of list.slice(0,20)) {
          if (!row || typeof row !== 'object') continue;
          const label = plain(row.label || row.lang), language = plain(row.lang);
          if (!korean(language,label)) continue;
          const cues: unknown = row.caption?.cues;
          if (Array.isArray(cues)) add(label,language,'player_caption_api','txt',cueText(cues));
        }
      }
    } else {
      const tracks = Array.from(doc.querySelectorAll<HTMLTrackElement>('video track, audio track'));
      if (tracks.length > 20) limited = true;
      for (const track of tracks.slice(0,20)) {
        if (!['subtitles','captions'].includes(track.kind) || !korean(track.srclang,track.label)) continue;
        const loaded = cueText(track.track?.cues);
        if (loaded.trim()) { add(track.label,track.srclang,'text_track_cues','txt',loaded);continue; }
        // No mode changes, media play, seek, player methods or resource discovery.
        if (!track.getAttribute('src')) continue;
        try {
          const url = new URL(track.src,win.location.href);
          if (url.protocol !== 'https:' || url.origin !== location.origin || url.username || url.password || url.hash) {blocked = true;continue;}
          const response = await fetch(url.href,{method:'GET',credentials:'same-origin',redirect:'manual',cache:'no-store',referrerPolicy:'no-referrer',signal:controller.signal});
          if (!response.ok || response.type === 'opaqueredirect') {blocked = true;continue;}
          const mime = response.headers.get('content-type') ?? '';
          if (!/^(?:text\/(?:vtt|plain)|application\/(?:x-subrip|ttml\+xml|xml|json|octet-stream))(?:;|$)/i.test(mime)) {blocked = true;continue;}
          if (Number(response.headers.get('content-length')) > 1000000) {limited = true;continue;}
          const reader = response.body?.getReader();
          if (!reader) continue;
          const decoder = new TextDecoder(); let text = '', size = 0;
          try {
            while (true) {
              const chunk = await reader.read(); if (chunk.done) break;
              size += chunk.value.byteLength;
              if (size > 1000000) {limited = true;break;}
              text += decoder.decode(chunk.value,{stream:true});
            }
            text += decoder.decode();
            if (size <= 1000000) add(track.label,track.srclang,'track_element','auto',text);
          } finally {await reader.cancel().catch(() => {});}
        } catch {blocked = true;}
      }
      // Only the player's dedicated transcript DOM, explicitly marked Korean.
      for (const root of Array.from(doc.querySelectorAll<HTMLElement>('#cs-script-list')).slice(0,5)) {
        const language = root.getAttribute('lang') ?? '';
        const label = root.getAttribute('aria-label') ?? '';
        if (!korean(language,label)) continue;
        const elements = Array.from(root.querySelectorAll('.cs-script-item-text'));
        if (elements.length > 20000) {limited = true;continue;}
        add(label || '한국어 스크립트',language,'caption_script_dom','txt',cueText(elements.map(element => ({text:element.textContent ?? ''}))));
      }
    }
    for (const frame of Array.from(doc.querySelectorAll<HTMLIFrameElement>('iframe')).slice(0,20)) {
      try {if (frame.contentWindow) await visit(frame.contentWindow,depth+1);} catch {blocked = true;}
    }
  }
  try {await visit(window,0);} catch {blocked = true;} finally {clearTimeout(timer);}
  return {tracks:out,blocked,limited};
}
