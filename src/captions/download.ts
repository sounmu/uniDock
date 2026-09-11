import { safeCaptionText } from './normalize';
export function downloadCaption(text: string, now = new Date()): void {
  if (!safeCaptionText(text.trimEnd())) throw new Error('UNSAFE_CAPTION');
  const blob = new Blob([text],{type:'text/plain;charset=utf-8'});
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  try {
    link.href = url;
    link.download = `uniDock-ko-${now.toISOString().replace(/[-:]/g,'').replace(/\.\d+Z$/,'Z')}.txt`;
    document.body.append(link); link.click();
  } finally {link.remove();setTimeout(() => URL.revokeObjectURL(url),1000);}
}
