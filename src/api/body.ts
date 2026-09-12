/** Bound decoded network bytes before JSON parsing; never retain error bodies. */
export async function readJsonBounded(response: Response, limit = 2_000_000): Promise<unknown> {
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw new Error('LIMIT');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('INVALID_RESPONSE');
  let bytes = 0, text = '';
  const decoder = new TextDecoder();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > limit) throw new Error('LIMIT');
      text += decoder.decode(chunk.value,{stream:true});
    }
    text += decoder.decode();
  } finally {await reader.cancel().catch(() => {});}
  try {return JSON.parse(text);} catch {throw new Error('INVALID_RESPONSE');}
}
