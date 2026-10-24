import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  captionServerToken,
  clearCaptionServerToken,
  saveCaptionServerToken,
  CAPTION_SERVER_TOKEN_KEY,
} from "../src/caption-server-settings";

let store: Record<string, unknown>;

beforeEach(() => {
  store = {};
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: store[key] })),
        set: vi.fn(async (values: Record<string, unknown>) => {
          Object.assign(store, values);
        }),
        remove: vi.fn(async (key: string) => {
          delete store[key];
        }),
      },
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

it("saves and reads a valid token", async () => {
  await saveCaptionServerToken("  abcd1234efgh  ");
  expect(store[CAPTION_SERVER_TOKEN_KEY]).toBe("abcd1234efgh");
  expect(await captionServerToken()).toBe("abcd1234efgh");
});

it("rejects a too-short token", async () => {
  await expect(saveCaptionServerToken("short")).rejects.toThrow();
});

it("returns null for a missing or malformed stored token", async () => {
  expect(await captionServerToken()).toBeNull();
  store[CAPTION_SERVER_TOKEN_KEY] = "bad token with spaces";
  expect(await captionServerToken()).toBeNull();
});

it("clears the token", async () => {
  await saveCaptionServerToken("abcd1234efgh");
  await clearCaptionServerToken();
  expect(await captionServerToken()).toBeNull();
});
