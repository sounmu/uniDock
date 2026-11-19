import { expect, it } from "vitest";
import { discoverPlayback } from "../entrypoints/lms.content";
import {
  PlaybackRuntime,
  type PlayerAddress,
  type RuntimePorts,
} from "../src/playback/runtime";
import type { StoredPlayback } from "../src/playback/storage";

// Opt-in: UNIDOCK_BENCH=1 npx vitest run tests/playback-lease.benchmark.test.ts
// "Before" = the same tree with HEAD's sequential entrypoints/lms.content.ts:
//   rm -rf /tmp/unidock-before && mkdir /tmp/unidock-before
//   rsync -a --exclude node_modules --exclude .git --exclude .output --exclude .omo ./ /tmp/unidock-before/
//   git show HEAD:entrypoints/lms.content.ts > /tmp/unidock-before/entrypoints/lms.content.ts
//   ln -s "$PWD/node_modules" /tmp/unidock-before/node_modules
//   (cd /tmp/unidock-before && UNIDOCK_BENCH=1 npx vitest run tests/playback-lease.benchmark.test.ts)
const RTT_MS = 20;
const COURSES = 12;
const RUNS = 7;
const origin = "https://mylms.korea.ac.kr";
const salt = "a".repeat(64);
const address: PlayerAddress = { tabId: 9, frameId: 2, documentId: "doc" };

interface Traffic {
  gets: number;
  peak: number;
  live: number;
}

/** Each course lists three modules; two of them must hydrate their items. */
function lms(rttMs: number, traffic: Traffic): typeof fetch {
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
    });
  const lecture = (id: number) => ({
    id,
    type: "ExternalTool",
    title: "Lecture",
    url: "https://example.invalid",
  });
  return async (input) => {
    traffic.gets++;
    traffic.peak = Math.max(traffic.peak, ++traffic.live);
    await new Promise((resolve) => setTimeout(resolve, rttMs));
    traffic.live--;
    const path = new URL(String(input)).pathname;
    if (path === "/api/v1/users/self") return json({ id: 42 });
    if (path === "/api/v1/courses")
      return json(
        Array.from({ length: COURSES }, (_, i) => ({
          id: 100 + i,
          name: `Course ${i}`,
        })),
      );
    const modules = path.match(/^\/api\/v1\/courses\/(\d+)\/modules$/);
    if (modules)
      return json([
        {
          id: 1,
          items_count: 1,
          items: [lecture(Number(modules[1]) * 10 + 1)],
        },
        { id: 2, items_count: 1 },
        { id: 3, items_count: 1 },
      ]);
    const items = path.match(
      /^\/api\/v1\/courses\/(\d+)\/modules\/(\d+)\/items$/,
    );
    if (items) return json([lecture(Number(items[1]) * 10 + Number(items[2]))]);
    throw new Error("unexpected endpoint");
  };
}

async function discoveryRun() {
  const traffic = { gets: 0, peak: 0, live: 0 };
  const started = performance.now();
  const result = await discoverPlayback(origin, salt, lms(RTT_MS, traffic));
  if (result.status !== "success") throw new Error(result.code);
  return { ms: performance.now() - started, ...traffic };
}

/** A real runtime with a started run; only the final lease() is timed. */
async function leaseRun() {
  const traffic = { gets: 0, peak: 0, live: 0 };
  let saved: StoredPlayback | null = null;
  let uuid = 0;
  const ports: RuntimePorts = {
    store: {
      load: async () => (saved ? structuredClone(saved) : null),
      save: async (value) => {
        saved = structuredClone(value);
      },
      clear: async () => {
        saved = null;
      },
      erase: async () => {
        saved = null;
      },
    },
    now: () => Date.now(),
    uuid: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}`,
    discover: async () => {
      const result = await discoverPlayback(origin, salt, lms(RTT_MS, traffic));
      if (result.status !== "success") throw new Error(result.code);
      return result.discovery;
    },
    bind: async () => {
      throw new Error("unused");
    },
    resolveBatch: async () => {
      const setup = await discoverPlayback(
        origin,
        salt,
        lms(0, { gets: 0, peak: 0, live: 0 }),
      );
      if (setup.status !== "success") throw new Error(setup.code);
      const first = setup.discovery.candidates[0]!;
      return {
        discovery: setup.discovery,
        items: [{ id: first.id, courseId: first.courseId }],
      };
    },
    open: async () => 9,
    navigate: async () => {},
    releaseTab: async () => {},
    control: async () => {},
    alarm: async () => {},
    clearAlarmPrefix: async () => {},
  };
  const runtime = new PlaybackRuntime(ports);
  await runtime.command({
    version: 1,
    type: "PLAYBACK_START",
    handles: ["00000000-0000-4000-8000-0000000000aa"],
    sourceTabId: 7,
    documentToken: "00000000-0000-4000-8000-000000000099",
  });
  const authorization = await runtime.authorize(address);
  if (!authorization) throw new Error("not authorized");
  await runtime.signal(address, authorization.binding, "playing");
  traffic.gets = 0;
  traffic.peak = 0;
  const started = performance.now();
  const lease = await runtime.lease(address, authorization.binding);
  const ms = performance.now() - started;
  expect(lease).not.toBeNull();
  return { ms, ...traffic };
}

const median = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

it.skipIf(!process.env.UNIDOCK_BENCH)(
  "benchmark: playback lease renewal discovery",
  async () => {
    const report = [
      `fixture: ${COURSES} courses x 3 modules (2 hydrated), RTT ${RTT_MS}ms fixed, ${RUNS} runs each; ` +
        `timed layers = discoverPlayback and PlaybackRuntime.lease (-> discover port -> discoverPlayback -> fixture fetch); ` +
        `not timed = background<->tab messaging, real LMS network`,
    ];
    for (const [layer, run] of [
      ["discoverPlayback", discoveryRun],
      ["PlaybackRuntime.lease", leaseRun],
    ] as const) {
      const runs = [];
      for (let i = 0; i < RUNS; i++) runs.push(await run());
      const times = runs.map((r) => r.ms);
      report.push(
        `${layer}: median ${median(times).toFixed(0)}ms, min ${Math.min(...times).toFixed(0)}ms, max ${Math.max(...times).toFixed(0)}ms, ` +
          `${runs[0]!.gets} GETs, peak in flight ${runs[0]!.peak}`,
      );
      expect(runs[0]!.gets).toBe(3 + COURSES * 3);
    }
    process.stdout.write(`\n${report.join("\n")}\n`);
  },
  120_000,
);
