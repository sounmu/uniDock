import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  CAPTION_RULE_KEEPALIVE_MS,
  CAPTION_RULE_PORT,
  installCaptionRuleCleanup,
  withCaptionMediaRule,
} from "../src/captions/referer-rule";

const url =
  "https://korea-cms-object.cdn.gov-ntruss.com/contents7/kruniv1001/0123456789abc/contents/media_files/screen.mp4";
let updates: { removeRuleIds?: number[]; addRules?: { id: number }[] }[];
let sessionRules: { id: number }[];
interface PanelPort {
  name: string;
  disconnect: ReturnType<typeof vi.fn>;
  postMessage: ReturnType<typeof vi.fn>;
  onDisconnect: { addListener(fn: () => void): void };
  onMessage: { addListener(fn: (message: unknown) => void): void };
  drop(): void;
  ready(): void;
}
let ports: PanelPort[];
let onConnect: ((port: unknown) => void) | undefined;

beforeEach(() => {
  updates = [];
  sessionRules = [];
  ports = [];
  onConnect = undefined;
  vi.stubGlobal("chrome", {
    runtime: {
      id: "abcdefghijklmnopabcdefghijklmnop",
      connect: vi.fn(({ name }: { name: string }) => {
        const listeners: (() => void)[] = [];
        const messages: ((message: unknown) => void)[] = [];
        const port: PanelPort = {
          name,
          disconnect: vi.fn(),
          postMessage: vi.fn(),
          onDisconnect: { addListener: (fn) => listeners.push(fn) },
          onMessage: { addListener: (fn) => messages.push(fn) },
          drop: () => listeners.forEach((fn) => fn()),
          ready: () => messages.forEach((fn) => fn({ type: "ready" })),
        };
        ports.push(port);
        return port;
      }),
      onConnect: { addListener: (fn: (port: unknown) => void) => (onConnect = fn) },
    },
    declarativeNetRequest: {
      updateSessionRules: vi.fn(async (u: (typeof updates)[number]) => {
        updates.push(u);
      }),
      getSessionRules: vi.fn(async () => sessionRules),
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

it("adds a scoped rule under a live port, then removes it and closes the port", async () => {
  const result = await withCaptionMediaRule(url, async () => "done");
  expect(result).toBe("done");
  const added = updates.find((u) => u.addRules)!.addRules![0] as unknown as {
    id: number;
    action: { requestHeaders: { header: string; value: string }[] };
    condition: Record<string, unknown>;
  };
  expect(added.action.requestHeaders[0]).toMatchObject({
    header: "referer",
    value: "https://kucom.korea.ac.kr/",
  });
  expect(added.condition.initiatorDomains).toEqual([
    "abcdefghijklmnopabcdefghijklmnop",
  ]);
  expect(added.condition.urlFilter).toBe(`|${url}|`);
  expect(added.condition.resourceTypes).toEqual(["xmlhttprequest"]);
  expect(ports).toHaveLength(1);
  expect(ports[0]!.name).toBe(`${CAPTION_RULE_PORT}:${added.id}`);
  expect(updates[updates.length - 1]!.removeRuleIds).toEqual([added.id]);
  expect(ports[0]!.disconnect).toHaveBeenCalled();
});

it("removes the rule even when the body throws", async () => {
  await expect(
    withCaptionMediaRule(url, async () => {
      throw new Error("boom");
    }),
  ).rejects.toThrow("boom");
  const id = updates.find((u) => u.addRules)!.addRules![0]!.id;
  expect(updates[updates.length - 1]!.removeRuleIds).toEqual([id]);
});

it("refuses an unsafe media url without touching rules", async () => {
  await expect(
    withCaptionMediaRule("https://evil.example.com/x.mp4", async () => "x"),
  ).rejects.toThrow("UNSUPPORTED_MEDIA");
  expect(updates).toHaveLength(0);
  expect(ports).toHaveLength(0);
});

function fakePort(name: string, sender: object) {
  let disconnected: (() => void) | undefined;
  return {
    name,
    sender,
    disconnect: vi.fn(),
    postMessage: vi.fn(),
    onMessage: { addListener: vi.fn() },
    onDisconnect: { addListener: (fn: () => void) => (disconnected = fn) },
    close: () => disconnected?.(),
  };
}

it("background removes a panel's rule when the panel port disconnects", async () => {
  await installCaptionRuleCleanup(() => true, 0);
  const port = fakePort(`${CAPTION_RULE_PORT}:1947005`, { id: "x" });
  onConnect!(port);
  port.close();
  await Promise.resolve();
  expect(updates).toContainEqual({ removeRuleIds: [1947005] });
});

it("background refuses rule ports from outside the panel or out of range", async () => {
  await installCaptionRuleCleanup((sender) => (sender as { ok?: boolean }).ok === true, 0);
  const stranger = fakePort(`${CAPTION_RULE_PORT}:1947005`, { ok: false });
  onConnect!(stranger);
  expect(stranger.disconnect).toHaveBeenCalled();
  const outOfRange = fakePort(`${CAPTION_RULE_PORT}:42`, { ok: true });
  onConnect!(outOfRange);
  expect(outOfRange.disconnect).toHaveBeenCalled();
});

it("background start removes leftover caption rules but leaves other rules", async () => {
  sessionRules = [{ id: 1947001 }, { id: 7 }, { id: 1947999 }];
  await installCaptionRuleCleanup(() => true, 0);
  expect(updates).toEqual([{ removeRuleIds: [1947001, 1947999] }]);
});

it("reconnects the rule port under the same name if the worker restarts mid-run", async () => {
  let finish!: () => void;
  const running = withCaptionMediaRule(url, () => new Promise<void>((resolve) => (finish = resolve)));
  await vi.waitFor(() => expect(ports).toHaveLength(1));
  ports[0]!.drop();
  expect(ports).toHaveLength(2);
  expect(ports[1]!.name).toBe(ports[0]!.name);
  finish();
  await running;
  ports[1]!.drop();
  expect(ports).toHaveLength(2);
});

it("background start keeps a rule whose panel reconnects within the grace period", async () => {
  vi.useFakeTimers();
  try {
    sessionRules = [{ id: 1947001 }, { id: 1947002 }];
    const swept = installCaptionRuleCleanup(() => true, 10_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(updates).toEqual([]);
    onConnect!(fakePort(`${CAPTION_RULE_PORT}:1947001`, {}));
    await vi.advanceTimersByTimeAsync(9_000);
    await swept;
    expect(updates).toEqual([{ removeRuleIds: [1947002] }]);
  } finally {
    vi.useRealTimers();
  }
});

it("background does not sweep before the grace period ends", async () => {
  vi.useFakeTimers();
  try {
    sessionRules = [{ id: 1947003 }];
    const swept = installCaptionRuleCleanup(() => true, 10_000);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(updates).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await swept;
    expect(updates).toEqual([{ removeRuleIds: [1947003] }]);
  } finally {
    vi.useRealTimers();
  }
});

it("background answers ready and listens for keepalives on a panel rule port", async () => {
  await installCaptionRuleCleanup(() => true, 0);
  const port = fakePort(`${CAPTION_RULE_PORT}:1947004`, {});
  onConnect!(port);
  expect(port.postMessage).toHaveBeenCalledWith({ type: "ready" });
  expect(port.onMessage.addListener).toHaveBeenCalled();
});

it("posts a keepalive on the rule port every 20 seconds while running", async () => {
  vi.useFakeTimers();
  try {
    let finish!: () => void;
    const running = withCaptionMediaRule(url, () => new Promise<void>((resolve) => (finish = resolve)));
    await vi.advanceTimersByTimeAsync(0);
    expect(ports[0]!.postMessage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(CAPTION_RULE_KEEPALIVE_MS);
    expect(ports[0]!.postMessage).toHaveBeenCalledWith({ type: "keepalive" });
    await vi.advanceTimersByTimeAsync(CAPTION_RULE_KEEPALIVE_MS);
    expect(ports[0]!.postMessage).toHaveBeenCalledTimes(2);
    finish();
    await running;
    await vi.advanceTimersByTimeAsync(CAPTION_RULE_KEEPALIVE_MS * 3);
    expect(ports[0]!.postMessage).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});

it("keeps reconnecting across many restarts while each new worker answers ready", async () => {
  let finish!: () => void;
  const running = withCaptionMediaRule(url, () => new Promise<void>((resolve) => (finish = resolve)));
  await vi.waitFor(() => expect(updates.some((u) => u.addRules)).toBe(true));
  for (let restart = 0; restart < 30; restart++) {
    ports.at(-1)!.drop();
    ports.at(-1)!.ready();
  }
  expect(ports).toHaveLength(31);
  finish();
  await running;
});

it("stops reconnecting after five drops in a row with no ready answer", async () => {
  let finish!: () => void;
  const running = withCaptionMediaRule(url, () => new Promise<void>((resolve) => (finish = resolve)));
  await vi.waitFor(() => expect(ports).toHaveLength(1));
  for (let drop = 0; drop < 10; drop++) ports.at(-1)!.drop();
  expect(ports).toHaveLength(6);
  finish();
  await running;
});

it("re-adds the same rule when a reconnected worker answers ready", async () => {
  let finish!: () => void;
  const running = withCaptionMediaRule(url, () => new Promise<void>((resolve) => (finish = resolve)));
  await vi.waitFor(() => expect(updates.some((u) => u.addRules)).toBe(true));
  const id = updates.find((u) => u.addRules)!.addRules![0]!.id;
  updates = [];
  ports.at(-1)!.drop();
  ports.at(-1)!.ready();
  await vi.waitFor(() => expect(updates).toHaveLength(1));
  expect(updates[0]!.removeRuleIds).toEqual([id]);
  expect(updates[0]!.addRules![0]!.id).toBe(id);
  finish();
  await running;
});
