import { afterEach, expect, it, vi } from "vitest";
import { AnalyticsRuntime } from "../src/analytics/runtime";
import { AnalyticsSink } from "../src/analytics/posthog";
import {
  ANALYTICS_HOST,
  ANALYTICS_KEY,
  isAnalyticsCommand,
  isAnalyticsEvent,
  type AnalyticsCommand,
} from "../src/analytics/contract";
import { EngagementClock } from "../src/analytics/engagement";

const key = "phc_unidock_synthetic_test";
const id = "00000000-0000-4000-8000-000000000001";
const data = {
  event: "action_clicked",
  action: "refresh",
  screen: "COURSES_LIST",
} as const;
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function fixture(token = key) {
  const stored: Record<string, unknown> = {};
  const get = vi.fn(async () => ({ ...stored }));
  const set = vi.fn(async (values: Record<string, unknown>) => {
    Object.assign(stored, values);
  });
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get,
        set,
        setAccessLevel: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn(async (name: string) => {
          delete stored[name];
        }),
      },
    },
  });
  const fetch = vi.fn(async () => new Response(null, { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  const runtime = new AnalyticsRuntime(token, "0.1.2");
  const capture = (consentId = id) =>
    runtime.command({ version: 1, type: "ANALYTICS_CAPTURE", consentId, data });
  const consent = (enabled: boolean) =>
    runtime.command({ version: 1, type: "ANALYTICS_CONSENT", enabled });
  const enable = async () => {
    const result = await consent(true);
    if (!("consentId" in result) || !result.consentId)
      throw new Error("Missing consent");
    return result.consentId;
  };
  return { stored, get, set, fetch, runtime, capture, consent, enable };
}

it("creates no ID, SDK traffic or storage before consent, after rejection, or with no configured key", async () => {
  const f = fixture();
  const uuid = vi.spyOn(crypto, "randomUUID");
  expect(
    await f.runtime.command({ version: 1, type: "ANALYTICS_STATUS" }),
  ).toEqual({ available: true, choice: "undecided" });
  await f.capture();
  expect(f.stored).toEqual({});
  expect(uuid).not.toHaveBeenCalled();
  await f.consent(false);
  expect(f.stored).toEqual({ [ANALYTICS_KEY]: { version: 1, enabled: false } });
  await f.capture();
  expect(f.fetch).not.toHaveBeenCalled();
  expect(uuid).not.toHaveBeenCalled();
  const off = fixture("");
  expect(await off.consent(true)).toEqual({
    available: false,
    choice: "undecided",
  });
  await off.capture();
  expect(off.stored).toEqual({});
  expect(off.fetch).not.toHaveBeenCalled();
});

it.each([
  null,
  true,
  { enabled: true },
  { version: 1, enabled: true, id: "student@example.com" },
  { version: 1, enabled: true, id, extra: "secret" },
])("treats invalid persisted consent as disabled: %j", async (stored) => {
  const f = fixture();
  f.stored[ANALYTICS_KEY] = stored;
  await f.capture();
  expect(f.fetch).not.toHaveBeenCalled();
});

it("uses the real SDK to send only static approved properties, no cookies/referrer/redirects, and survives worker restart", async () => {
  const f = fixture();
  const consentId = await f.enable();
  expect(f.fetch).not.toHaveBeenCalled();
  const nextWorker = new AnalyticsRuntime(key, "0.1.2");
  await nextWorker.command({
    version: 1,
    type: "ANALYTICS_CAPTURE",
    consentId,
    data,
  });
  expect(f.fetch).toHaveBeenCalledOnce();
  const [url, options] = (
    f.fetch.mock.calls as unknown as [string, RequestInit][]
  )[0]!;
  expect(url).toBe(`${ANALYTICS_HOST}/batch/`);
  expect(options).toMatchObject({
    method: "POST",
    credentials: "omit",
    redirect: "error",
    referrerPolicy: "no-referrer",
    cache: "no-store",
  });
  const body = JSON.parse(options.body as string);
  expect(body.api_key).toBe(key);
  expect(body.batch).toHaveLength(1);
  expect(body.batch[0]).toMatchObject({
    event: "action_clicked",
    distinct_id: consentId,
  });
  expect(body.batch[0].properties).toEqual({
    action: "refresh",
    screen: "COURSES_LIST",
    extension_version: "0.1.2",
    $lib: "unidock",
    $lib_version: "1",
    $geoip_disable: true,
    $process_person_profile: false,
    $ip: null,
  });
  expect(Object.keys(body.batch[0]).sort()).toEqual([
    "distinct_id",
    "event",
    "properties",
    "timestamp",
    "uuid",
  ]);
});

it("aborts in-flight requests on revoke and never retries or replays old consent after re-enabling", async () => {
  const f = fixture();
  const consentId = await f.enable();
  let signal!: AbortSignal;
  const fetch = vi.fn(
    (_url: string, options: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        signal = options.signal!;
        signal.addEventListener(
          "abort",
          () => reject(new Error("PRIVATE_NETWORK_ERROR")),
          { once: true },
        );
      }),
  );
  vi.stubGlobal("fetch", fetch);
  const sent = f.capture(consentId);
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  await f.consent(false);
  expect(signal.aborted).toBe(true);
  await sent;
  expect(f.stored[ANALYTICS_KEY]).toEqual({ version: 1, enabled: false });
  const newId = await f.enable();
  expect(newId).not.toBe(consentId);
  await f.capture(consentId);
  expect(fetch).toHaveBeenCalledOnce();
});

it("clear-data invalidates storage reads in flight and requires fresh consent", async () => {
  const f = fixture();
  const consentId = await f.enable();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const before = { ...f.stored };
  f.get.mockImplementationOnce(async () => {
    await pending;
    return before;
  });
  const capture = f.capture(consentId);
  await Promise.resolve();
  const erase = f.runtime.erase();
  release();
  await Promise.all([capture, erase]);
  expect(f.stored).not.toHaveProperty(ANALYTICS_KEY);
  expect(f.fetch).not.toHaveBeenCalled();
  await f.capture(consentId);
  expect(f.fetch).not.toHaveBeenCalled();
  const nextId = await f.enable();
  await f.capture(nextId);
  expect(f.fetch).toHaveBeenCalledOnce();
});

it("clear-data wins over a pending enable write", async () => {
  const f = fixture();
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.set.mockImplementationOnce(async (values) => {
    await wait;
    Object.assign(f.stored, values);
  });
  const enabling = f.consent(true);
  await vi.waitFor(() => expect(f.set).toHaveBeenCalledOnce());
  const erase = f.runtime.erase();
  release();
  await Promise.all([enabling, erase]);
  expect(f.stored).not.toHaveProperty(ANALYTICS_KEY);
  expect(f.fetch).not.toHaveBeenCalled();
});

it("keeps the same ID when two panels enable sharing concurrently", async () => {
  const f = fixture();
  const [first, second] = await Promise.all([f.enable(), f.enable()]);
  expect(first).toBe(second);
  await f.capture(first);
  expect(f.fetch).toHaveBeenCalledOnce();
});

it("drops network failures without retrying, logging or affecting later events", async () => {
  const f = fixture();
  const consentId = await f.enable();
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  f.fetch.mockRejectedValueOnce(new Error("PRIVATE_URL_TOKEN"));
  await f.capture(consentId);
  expect(f.fetch).toHaveBeenCalledOnce();
  expect(error).not.toHaveBeenCalled();
  await f.capture(consentId);
  expect(f.fetch).toHaveBeenCalledTimes(2);
});

it("bounds traffic and rejects arbitrary commands/properties even at runtime", async () => {
  const f = fixture();
  const consentId = await f.enable();
  await f.runtime.command({
    version: 1,
    type: "ANALYTICS_CAPTURE",
    consentId,
    data: { ...data, url: "SECRET" },
  } as unknown as AnalyticsCommand);
  expect(f.fetch).not.toHaveBeenCalled();
  for (let n = 0; n < 121; n++) await f.capture(consentId);
  expect(f.fetch).toHaveBeenCalledTimes(120);
});

it("adapter refuses arbitrary URLs, oversized bodies and GET even if a future SDK tries them", async () => {
  const f = fixture();
  const sink = new AnalyticsSink(key);
  await expect(
    sink.fetch(`${ANALYTICS_HOST}/flags/`, {
      method: "POST",
      body: "{}",
      headers: {},
    }),
  ).rejects.toThrow("ANALYTICS_BLOCKED");
  await expect(
    sink.fetch(`${ANALYTICS_HOST}/batch/`, { method: "GET", headers: {} }),
  ).rejects.toThrow("ANALYTICS_BLOCKED");
  await expect(
    sink.fetch(`${ANALYTICS_HOST}/batch/`, {
      method: "POST",
      body: "x".repeat(8193),
      headers: {},
    }),
  ).rejects.toThrow("ANALYTICS_BLOCKED");
  expect(f.fetch).not.toHaveBeenCalled();
});

it("rejects unknown event names, fields and out-of-range time measurements", () => {
  for (const value of [
    { ...data, course: "PRIVATE" },
    { ...data, action: "PRIVATE" },
    { ...data, screen: "PRIVATE" },
    { event: "$pageview", screen: "COURSES_LIST" },
    { event: "feature_result", feature: "courses", outcome: "PRIVATE_ERROR" },
    {
      event: "panel_engagement",
      screen: "INFO",
      visible_seconds: 61,
      active_seconds: 0,
    },
    {
      event: "panel_engagement",
      screen: "INFO",
      visible_seconds: 10,
      active_seconds: 11,
    },
    {
      event: "panel_engagement",
      screen: "INFO",
      visible_seconds: 10.1,
      active_seconds: 0,
    },
  ])
    expect(isAnalyticsEvent(value)).toBe(false);
  expect(
    isAnalyticsCommand({
      version: 1,
      type: "ANALYTICS_CONSENT",
      enabled: true,
      id: "PRIVATE",
    }),
  ).toBe(false);
  expect(
    isAnalyticsEvent({
      event: "feature_result",
      feature: "download",
      outcome: "success",
    }),
  ).toBe(true);
});

it("counts visibility and focused activity independently and caps inactivity and sleep gaps", () => {
  const clock = new EngagementClock(0);
  for (let n = 5; n <= 30; n += 5) clock.tick(n * 1000, true, true);
  expect(clock.take()).toEqual({ visible_seconds: 30, active_seconds: 30 });
  for (let n = 35; n <= 60; n += 5) clock.tick(n * 1000, true, false);
  expect(clock.take()).toEqual({ visible_seconds: 30, active_seconds: 0 });
  clock.tick(65000, true, true); // inactivity exceeded
  expect(clock.take()).toEqual({ visible_seconds: 5, active_seconds: 0 });
  clock.interact(65000);
  clock.tick(70000, true, true);
  clock.tick(75000, false, true);
  expect(clock.take()).toEqual({ visible_seconds: 5, active_seconds: 5 });
  clock.tick(3600000, true, true);
  expect(clock.take()).toEqual({ visible_seconds: 0, active_seconds: 0 });
});
