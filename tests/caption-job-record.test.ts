import { beforeEach, expect, it, vi } from "vitest";
import {
  CAPTION_ACTIVE_JOB_KEY,
  CAPTION_INSTALL_SALT_KEY,
  captionJobKey,
  MAX_ACTIVE_JOBS,
  clearActiveJob,
  loadActiveJobs,
  saveActiveJob,
} from "../src/captions/job-record";

let store: Record<string, unknown>;

beforeEach(() => {
  store = {};
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: vi.fn(async (key: string) => (key in store ? { [key]: store[key] } : {})),
        set: vi.fn(async (values: Record<string, unknown>) => Object.assign(store, values)),
        remove: vi.fn(async (key: string) => {
          delete store[key];
        }),
      },
    },
  });
});

it("derives a stable key that never contains the KU content id", async () => {
  const first = await captionJobKey("0123456789abc");
  const again = await captionJobKey("0123456789abc");
  const other = await captionJobKey("0123456789abd");
  expect(first).toMatch(/^unidock-[0-9a-f]{40}$/);
  expect(first).not.toContain("0123456789abc");
  expect(again).toBe(first);
  expect(other).not.toBe(first);
  expect(store[CAPTION_INSTALL_SALT_KEY]).toMatch(/^[0-9a-f]{64}$/);
});

it("gives a different key on another install (salt)", async () => {
  const first = await captionJobKey("0123456789abc");
  delete store[CAPTION_INSTALL_SALT_KEY];
  expect(await captionJobKey("0123456789abc")).not.toBe(first);
});

it("keeps one accepted job per lecture and clears jobs one at a time", async () => {
  const key = await captionJobKey("0123456789abc");
  const other = await captionJobKey("0123456789abd");
  expect(await loadActiveJobs()).toEqual([]);
  await saveActiveJob({ jobId: "job_1", key });
  await saveActiveJob({ jobId: "job_2", key: other });
  expect(await loadActiveJobs()).toEqual([{ jobId: "job_1", key }, { jobId: "job_2", key: other }]);
  await saveActiveJob({ jobId: "job_3", key });
  expect(await loadActiveJobs()).toEqual([{ jobId: "job_2", key: other }, { jobId: "job_3", key }]);
  await clearActiveJob("job_2");
  expect(await loadActiveJobs()).toEqual([{ jobId: "job_3", key }]);
  await clearActiveJob("job_3");
  expect(CAPTION_ACTIVE_JOB_KEY in store).toBe(false);
});

it("reads a 0.5.3 single record and skips malformed entries", async () => {
  const key = await captionJobKey("0123456789abc");
  store[CAPTION_ACTIVE_JOB_KEY] = { jobId: "job_1", key };
  expect(await loadActiveJobs()).toEqual([{ jobId: "job_1", key }]);
  store[CAPTION_ACTIVE_JOB_KEY] = [
    "job_1",
    { jobId: "bad id/..", key },
    { jobId: "job_1", key: "0123456789abc" },
    { jobId: "job_1" },
    { jobId: "job_2", key },
  ];
  expect(await loadActiveJobs()).toEqual([{ jobId: "job_2", key }]);
});

it("keeps at most MAX_ACTIVE_JOBS records, dropping the oldest", async () => {
  for (let i = 0; i <= MAX_ACTIVE_JOBS; i++)
    await saveActiveJob({ jobId: `job_${i}`, key: await captionJobKey(`lecture${i}`) });
  const jobs = await loadActiveJobs();
  expect(jobs).toHaveLength(MAX_ACTIVE_JOBS);
  expect(jobs[0]?.jobId).toBe("job_1");
});
