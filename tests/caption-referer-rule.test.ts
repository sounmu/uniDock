import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  CAPTION_RULE_PORT,
  installCaptionRuleCleanup,
  withCaptionMediaRule,
} from "../src/captions/referer-rule";

const url =
  "https://korea-cms-object.cdn.gov-ntruss.com/contents7/kruniv1001/0123456789abc/contents/media_files/screen.mp4";
let updates: { removeRuleIds?: number[]; addRules?: { id: number }[] }[];
let sessionRules: { id: number }[];
let ports: { name: string; disconnect: ReturnType<typeof vi.fn> }[];
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
        const port = { name, disconnect: vi.fn() };
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
    onDisconnect: { addListener: (fn: () => void) => (disconnected = fn) },
    close: () => disconnected?.(),
  };
}

it("background removes a panel's rule when the panel port disconnects", async () => {
  await installCaptionRuleCleanup(() => true);
  const port = fakePort(`${CAPTION_RULE_PORT}:1947005`, { id: "x" });
  onConnect!(port);
  port.close();
  await Promise.resolve();
  expect(updates).toContainEqual({ removeRuleIds: [1947005] });
});

it("background refuses rule ports from outside the panel or out of range", async () => {
  await installCaptionRuleCleanup((sender) => (sender as { ok?: boolean }).ok === true);
  const stranger = fakePort(`${CAPTION_RULE_PORT}:1947005`, { ok: false });
  onConnect!(stranger);
  expect(stranger.disconnect).toHaveBeenCalled();
  const outOfRange = fakePort(`${CAPTION_RULE_PORT}:42`, { ok: true });
  onConnect!(outOfRange);
  expect(outOfRange.disconnect).toHaveBeenCalled();
});

it("background start removes leftover caption rules but leaves other rules", async () => {
  sessionRules = [{ id: 1947001 }, { id: 7 }, { id: 1947999 }];
  await installCaptionRuleCleanup(() => true);
  expect(updates).toEqual([{ removeRuleIds: [1947001, 1947999] }]);
});
