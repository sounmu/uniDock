import { expect, it, vi } from "vitest";

const startCaptionWork = vi.hoisted(() => vi.fn());
vi.mock("../src/captions/offscreen-link", () => ({ startCaptionWork }));

it("starts caption work once when the offscreen document loads", async () => {
  await import("../entrypoints/offscreen/main");
  expect(startCaptionWork).toHaveBeenCalledOnce();
});
