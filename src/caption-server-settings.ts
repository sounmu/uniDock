export const CAPTION_SERVER_TOKEN_KEY = "unidock.caption-server-token.v1";

export function captionServerOrigin(): string {
  return __UNIDOCK_CAPTION_SERVER__;
}

function validToken(value: string): boolean {
  return /^[\x21-\x7e]{8,4096}$/.test(value);
}

export async function captionServerToken(): Promise<string | null> {
  const values = await chrome.storage.local.get(CAPTION_SERVER_TOKEN_KEY);
  const token = values[CAPTION_SERVER_TOKEN_KEY];
  return typeof token === "string" && validToken(token) ? token : null;
}

export async function saveCaptionServerToken(token: string): Promise<void> {
  const trimmed = token.trim();
  if (!validToken(trimmed)) throw new Error("INVALID_TOKEN");
  await chrome.storage.local.set({ [CAPTION_SERVER_TOKEN_KEY]: trimmed });
}

export async function clearCaptionServerToken(): Promise<void> {
  await chrome.storage.local.remove(CAPTION_SERVER_TOKEN_KEY);
}
