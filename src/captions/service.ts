import { collectCaptionSources } from './extract';
import { normalizeCaptions, type Caption } from './normalize';
export type CaptionResult = {status:'success';captions:Caption[];blocked:boolean} | {status:'error';code:'ACTIVATE_TAB'|'NO_KOREAN_CAPTIONS'|'UNSAFE_CAPTION'|'TIMEOUT'|'RELOAD_TAB'};
export async function detectCaptions(): Promise<CaptionResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
    if (tab?.id === undefined || !tab.url || new URL(tab.url).protocol !== 'https:') return {status:'error',code:'ACTIVATE_TAB'};
    const id = tab.id;
    const work = async (): Promise<CaptionResult> => {
      const dom = await chrome.scripting.executeScript({target:{tabId:id},world:'ISOLATED',func:collectCaptionSources,args:['dom']});
      // Lock the second read to the same document, not a replacement login page.
      const documentId = dom[0]?.documentId;
      if (!documentId) return {status:'error',code:'RELOAD_TAB'};
      const player = await chrome.scripting.executeScript({target:{tabId:id,documentIds:[documentId]},world:'MAIN',func:collectCaptionSources,args:['player']});
      const current = await chrome.tabs.get(id);
      if (current.url !== tab.url || player[0]?.documentId !== documentId) return {status:'error',code:'RELOAD_TAB'};
      const sources: unknown[] = []; let blocked = false;
      for (const batch of [...dom,...player]) {
        const row = batch.result;
        if (!row || !Array.isArray(row.tracks) || row.tracks.length > 20) {blocked=true;continue;}
        sources.push(...row.tracks); blocked ||= Boolean(row.blocked || row.limited);
      }
      const normalized = normalizeCaptions(sources);
      blocked ||= normalized.blocked;
      if (!normalized.captions.length) return {status:'error',code:blocked ? 'UNSAFE_CAPTION' : 'NO_KOREAN_CAPTIONS'};
      return {status:'success',captions:normalized.captions,blocked};
    };
    return await Promise.race([work(),new Promise<CaptionResult>(resolve => {timer=setTimeout(() => resolve({status:'error',code:'TIMEOUT'}),15000);})]);
  } catch {return {status:'error',code:'ACTIVATE_TAB'};} finally {clearTimeout(timer);}
}
