import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  CAPTION_RULE_SWEEP_GRACE_MS,
  CaptionMediaRules,
  withCaptionMediaRule,
} from "../src/captions/referer-rule";
import { isCaptionRuleId } from "../src/captions/work-protocol";

const url =
  "https://korea-cms-object.cdn.gov-ntruss.com/contents7/kruniv1001/0123456789abc/contents/media_files/screen.mp4";
interface Update {
  removeRuleIds?: number[];
  addRules?: {
    id: number;
    action: { requestHeaders: { header: string; value: string }[] };
    condition: Record<string, unknown>;
  }[];
}
let updates: Update[];
let sessionRules: { id: number }[];
let refuse: boolean;

beforeEach(() => {
  updates = [];
  sessionRules = [];
  refuse = false;
  vi.stubGlobal("chrome", {
    runtime: { id: "abcdefghijklmnopabcdefghijklmnop" },
    declarativeNetRequest: {
      updateSessionRules: vi.fn(async (update: Update) => {
        if (refuse) throw new Error("refused");
        updates.push(update);
      }),
      getSessionRules: vi.fn(async () => sessionRules),
    },
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function channel(installed = true) {
  const calls: string[] = [];
  return {
    calls,
    add: vi.fn(async (id: number, mediaUrl: string) => {
      calls.push(`add:${id}:${mediaUrl}`);
      return installed;
    }),
    remove: vi.fn(async (id: number) => {
      calls.push(`remove:${id}`);
    }),
  };
}

it("asks for a rule before the body runs and removes it afterwards", async () => {
  const worker = channel();
  const result = await withCaptionMediaRule(url, worker, async () => {
    worker.calls.push("body");
    return "done";
  });
  expect(result).toBe("done");
  const id = worker.add.mock.calls[0]![0];
  expect(isCaptionRuleId(id)).toBe(true);
  expect(worker.calls).toEqual([`add:${id}:${url}`, "body", `remove:${id}`]);
});

it("removes the rule even when the body throws", async () => {
  const worker = channel();
  await expect(
    withCaptionMediaRule(url, worker, async () => {
      throw new Error("boom");
    }),
  ).rejects.toThrow("boom");
  expect(worker.remove).toHaveBeenCalledWith(worker.add.mock.calls[0]![0]);
});

it("does not read media when the worker could not install the rule", async () => {
  const worker = channel(false);
  const body = vi.fn(async () => "x");
  await expect(withCaptionMediaRule(url, worker, body)).rejects.toThrow("RULE");
  expect(body).not.toHaveBeenCalled();
  expect(worker.remove).toHaveBeenCalledOnce();
});

it("refuses an unsafe media url without asking for a rule", async () => {
  const worker = channel();
  await expect(
    withCaptionMediaRule("https://evil.example.com/x.mp4", worker, async () => "x"),
  ).rejects.toThrow("UNSUPPORTED_MEDIA");
  expect(worker.calls).toEqual([]);
});

it("installs a rule scoped to one media url, the extension's own requests and the player referer", async () => {
  const rules = new CaptionMediaRules();
  expect(await rules.add(1947005, url)).toBe(true);
  expect(updates).toHaveLength(1);
  expect(updates[0]!.removeRuleIds).toEqual([1947005]);
  const added = updates[0]!.addRules![0]!;
  expect(added.id).toBe(1947005);
  expect(added.action.requestHeaders[0]).toMatchObject({
    header: "referer",
    value: "https://kucom.korea.ac.kr/",
  });
  expect(added.condition.initiatorDomains).toEqual(["abcdefghijklmnopabcdefghijklmnop"]);
  expect(added.condition.urlFilter).toBe(`|${url}|`);
  expect(added.condition.resourceTypes).toEqual(["xmlhttprequest"]);
});

it("refuses a rule id outside the caption range and a url that is not lecture media", async () => {
  const rules = new CaptionMediaRules();
  expect(await rules.add(42, url)).toBe(false);
  expect(await rules.add(1947005, "https://evil.example.com/x.mp4")).toBe(false);
  expect(updates).toEqual([]);
});

it("reports a rule Chrome refused and does not keep it from the next sweep", async () => {
  const rules = new CaptionMediaRules();
  refuse = true;
  expect(await rules.add(1947005, url)).toBe(false);
  refuse = false;
  sessionRules = [{ id: 1947005 }];
  await rules.sweep(0);
  expect(updates).toEqual([{ removeRuleIds: [1947005] }]);
});

it("removes a rule on request, and every rule of a document that went away", async () => {
  const rules = new CaptionMediaRules();
  await rules.add(1947001, url);
  await rules.add(1947002, url);
  await rules.add(1947003, url);
  updates = [];
  await rules.remove(1947002);
  expect(updates).toEqual([{ removeRuleIds: [1947002] }]);
  await rules.clear();
  expect(updates[1]).toEqual({ removeRuleIds: [1947001, 1947003] });
  // Nothing is left to clear, so Chrome is not asked again.
  await rules.clear();
  expect(updates).toHaveLength(2);
});

it("worker start removes leftover caption rules but leaves other rules", async () => {
  sessionRules = [{ id: 1947001 }, { id: 7 }, { id: 1947999 }];
  await new CaptionMediaRules().sweep(0);
  expect(updates).toEqual([{ removeRuleIds: [1947001, 1947999] }]);
});

it("worker start keeps a rule its document asks for again within the grace period", async () => {
  vi.useFakeTimers();
  sessionRules = [{ id: 1947001 }, { id: 1947002 }];
  const rules = new CaptionMediaRules();
  const swept = rules.sweep(10_000);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(updates).toEqual([]);
  await rules.add(1947001, url);
  updates = [];
  await vi.advanceTimersByTimeAsync(9_000);
  await swept;
  expect(updates).toEqual([{ removeRuleIds: [1947002] }]);
});

it("worker start waits out a 10 second grace period by default", async () => {
  vi.useFakeTimers();
  sessionRules = [{ id: 1947006 }];
  const swept = new CaptionMediaRules().sweep();
  await vi.advanceTimersByTimeAsync(CAPTION_RULE_SWEEP_GRACE_MS - 1);
  expect(updates).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  await swept;
  expect(updates).toEqual([{ removeRuleIds: [1947006] }]);
  expect(CAPTION_RULE_SWEEP_GRACE_MS).toBe(10_000);
});

it("a sweep that cannot read the rules or remove them does not throw", async () => {
  vi.mocked(chrome.declarativeNetRequest.getSessionRules).mockRejectedValueOnce(new Error("gone"));
  await expect(new CaptionMediaRules().sweep(0)).resolves.toBeUndefined();
  sessionRules = [{ id: 1947001 }];
  refuse = true;
  await expect(new CaptionMediaRules().sweep(0)).resolves.toBeUndefined();
});
