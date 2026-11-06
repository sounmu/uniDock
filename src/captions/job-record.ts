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

export interface ActiveJob {
  jobId: string;
  /** `captionJobKey` of the lecture the job belongs to. */
  key: string;
}

/** Accepted jobs kept for resuming; one per lecture, oldest dropped first. */
export const MAX_ACTIVE_JOBS = 8;
const RECORD_LOCK = "unidock-caption-active-jobs";

function parseJob(value: unknown): ActiveJob | null {
  const job = value as Partial<ActiveJob> | null | undefined;
  const jobId = job?.jobId;
  const key = job?.key;
  return typeof jobId === "string" &&
    /^[\w-]{1,128}$/.test(jobId) &&
    typeof key === "string" &&
    /^unidock-[0-9a-f]{40}$/.test(key)
    ? { jobId, key }
    : null;
}

/** Reads the stored list; a 0.5.3 single record is read as a list of one. */
export function parseActiveJobs(value: unknown): ActiveJob[] {
  const jobs: ActiveJob[] = [];
  for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
    const job = parseJob(item);
    if (job && !jobs.some((j) => j.key === job.key || j.jobId === job.jobId)) jobs.push(job);
  }
  return jobs.slice(-MAX_ACTIVE_JOBS);
}

export async function loadActiveJobs(): Promise<ActiveJob[]> {
  const values = await chrome.storage.local.get(CAPTION_ACTIVE_JOB_KEY);
  return parseActiveJobs(values[CAPTION_ACTIVE_JOB_KEY]);
}

/** Panels and the worker both edit the list; the lock keeps their edits from overwriting each other. */
function editActiveJobs(edit: (jobs: ActiveJob[]) => ActiveJob[]): Promise<void> {
  return navigator.locks.request(RECORD_LOCK, async () => {
    const jobs = edit(await loadActiveJobs()).slice(-MAX_ACTIVE_JOBS);
    if (jobs.length) await chrome.storage.local.set({ [CAPTION_ACTIVE_JOB_KEY]: jobs });
    else await chrome.storage.local.remove(CAPTION_ACTIVE_JOB_KEY);
  });
}

export function saveActiveJob(job: ActiveJob): Promise<void> {
  const saved = { jobId: job.jobId, key: job.key };
  return editActiveJobs((jobs) => [
    ...jobs.filter((j) => j.key !== saved.key && j.jobId !== saved.jobId),
    saved,
  ]);
}

export function clearActiveJob(jobId: string): Promise<void> {
  return editActiveJobs((jobs) => jobs.filter((j) => j.jobId !== jobId));
}
