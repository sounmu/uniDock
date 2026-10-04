// @vitest-environment jsdom
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mount, click } from "./ui-helpers";

let ui: Awaited<ReturnType<typeof mount>> | undefined;
beforeEach(() => vi.resetModules());
afterEach(async () => {
  await ui?.unmount();
  ui = undefined;
  vi.unstubAllGlobals();
});
function stub(updated: unknown) {
  const sendMessage = vi.fn().mockResolvedValue(updated);
  vi.stubGlobal("chrome", {
    runtime: { sendMessage, getManifest: () => ({ version: "0.1.2" }) },
  });
  return sendMessage;
}

it("asks once per panel, shows the bundled notes link and can be dismissed", async () => {
  const sendMessage = stub({ updated: true });
  const { UpdateNotice } =
    await import("../entrypoints/sidepanel/UpdateNotice");
  ui = await mount(
    <StrictMode>
      <UpdateNotice />
    </StrictMode>,
  );
  await vi.waitFor(() =>
    expect(document.body.textContent).toContain(
      "uniDock이 0.1.2 버전으로 업데이트되었습니다.",
    ),
  );
  expect(sendMessage).toHaveBeenCalledExactlyOnceWith({
    version: 1,
    type: "UPDATE_NOTICE_TAKE",
  });
  expect(
    document.querySelector<HTMLAnchorElement>('a[href="updates.html"]')?.target,
  ).toBe("_blank");
  await click("닫기");
  expect(document.querySelector('[aria-label="업데이트 안내"]')).toBeNull();
});

it("stays hidden without a pending update or when messaging fails", async () => {
  for (const reply of [{ updated: false }, undefined, { updated: "yes" }]) {
    vi.resetModules();
    stub(reply);
    const { UpdateNotice } =
      await import("../entrypoints/sidepanel/UpdateNotice");
    ui = await mount(<UpdateNotice />);
    await Promise.resolve();
    expect(document.querySelector('[aria-label="업데이트 안내"]')).toBeNull();
    await ui.unmount();
    ui = undefined;
  }
  vi.resetModules();
  vi.stubGlobal("chrome", {});
  const { UpdateNotice } =
    await import("../entrypoints/sidepanel/UpdateNotice");
  ui = await mount(<UpdateNotice />);
  await Promise.resolve();
  expect(document.querySelector('[aria-label="업데이트 안내"]')).toBeNull();
});
