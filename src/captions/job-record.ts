export const CAPTION_INSTALL_SALT_KEY = "unidock.caption-install-salt.v1";
export const CAPTION_ACTIVE_JOB_KEY = "unidock.caption-active-job.v1";

const hex = (bytes: ArrayBuffer | Uint8Array) =>
  [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function installSalt(): Promise<Uint8Array<ArrayBuffer>> {
  const values = await chrome.storage.local.get(CAPTION_INSTALL_SALT_KEY);
  const stored = values[CAPTION_INSTALL_SALT_KEY];
  if (typeof stored === "string" && /^[0-9a-f]{64}$/.test(stored))
    return new Uint8Array(stored.match(/../g)!.map((b) => parseInt(b, 16)));
  const salt = crypto.getRandomValues(new Uint8Array(32));
  await chrome.storage.local.set({ [CAPTION_INSTALL_SALT_KEY]: hex(salt) });
  return salt;
}

/**
 * Idempotency key for one lecture. An HMAC over the KU content id with a
 * per-install salt keeps duplicate requests stable for this install while the
 * server never receives the LMS identifier itself.
 */
export async function captionJobKey(contentId: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    await installSalt(),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`ku-media:${contentId}`),
  );
  return `unidock-${hex(mac).slice(0, 40)}`;
}

export async function loadActiveJob(): Promise<string | null> {
  const values = await chrome.storage.local.get(CAPTION_ACTIVE_JOB_KEY);
  const value = values[CAPTION_ACTIVE_JOB_KEY];
  return typeof value === "string" && /^[\w-]{1,128}$/.test(value) ? value : null;
}

export async function saveActiveJob(jobId: string): Promise<void> {
  await chrome.storage.local.set({ [CAPTION_ACTIVE_JOB_KEY]: jobId });
}

export async function clearActiveJob(): Promise<void> {
  await chrome.storage.local.remove(CAPTION_ACTIVE_JOB_KEY);
}
