import { beforeEach, expect, it, vi } from "vitest";
import {
  CAPTION_ACTIVE_JOB_KEY,
  CAPTION_INSTALL_SALT_KEY,
  captionJobKey,
  clearActiveJob,
  loadActiveJob,
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

it("stores, reads and clears the accepted job with its lecture key", async () => {
  const key = await captionJobKey("0123456789abc");
  expect(await loadActiveJob()).toBeNull();
  await saveActiveJob({ jobId: "job_1", key });
  expect(await loadActiveJob()).toEqual({ jobId: "job_1", key });
  for (const bad of [
    "job_1",
    { jobId: "bad id/..", key },
    { jobId: "job_1", key: "0123456789abc" },
    { jobId: "job_1" },
  ]) {
    store[CAPTION_ACTIVE_JOB_KEY] = bad;
    expect(await loadActiveJob()).toBeNull();
  }
  await saveActiveJob({ jobId: "job_2", key });
  await clearActiveJob();
  expect(await loadActiveJob()).toBeNull();
});
