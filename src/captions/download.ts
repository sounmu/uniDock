import { normalizeItems, transcriptText, type Transcript } from './transcript';
export function exportTranscript(value: Transcript): {json:string;text:string} {
  const items = normalizeItems(value.items);
  if (!items.length || items.length !== value.itemCount || !Number.isFinite(Date.parse(value.extractedAt))) throw new Error('INVALID_CAPTION');
  const source = new URL(value.sourceUrl);
  if (source.protocol !== 'https:' || source.username || source.password) throw new Error('INVALID_CAPTION');
  // Explicit projection prevents player resource URLs/configuration leaking into JSON.
  const transcript: Transcript = {sourceUrl:value.sourceUrl,pageTitle:value.pageTitle,extractedAt:value.extractedAt,itemCount:items.length,items};
  return {json:JSON.stringify(transcript,null,2)+'\n',text:transcriptText(transcript)};
}
export async function downloadCaption(value: Transcript): Promise<void> {
  const files = exportTranscript(value);
  const stem = `output/uniDock-${value.extractedAt.replace(/[-:]/g,'').replace(/\.\d+Z$/,'Z')}`;
  for (const [extension,body,type] of [['txt',files.text,'text/plain'],['json',files.json,'application/json']] as const) {
    const url = URL.createObjectURL(new Blob([body],{type:`${type};charset=utf-8`}));
    try {
      await chrome.downloads.download({url,filename:`${stem}.${extension}`,conflictAction:'uniquify',saveAs:false});
    } finally {setTimeout(() => URL.revokeObjectURL(url),60000);}
  }
}
