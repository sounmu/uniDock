// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mount } from "./ui-helpers";

const consentId = "00000000-0000-4000-8000-000000000001";
let ui: Awaited<ReturnType<typeof mount>>;
beforeEach(() => {
  vi.resetModules();
});
afterEach(async () => {
  await ui?.unmount();
  vi.unstubAllGlobals();
});
it("does not count clicks on aria-disabled or disabled controls", async () => {
  const sendMessage = vi.fn(async (message: { type: string }) =>
    message.type === "ANALYTICS_STATUS"
      ? { available: true, choice: "enabled", consentId }
      : undefined,
  );
  vi.stubGlobal("chrome", {
    runtime: { sendMessage },
    storage: { onChanged: { addListener() {}, removeListener() {} } },
  });
  const { useAnalytics } =
    await import("../entrypoints/sidepanel/useAnalytics");
  function Probe() {
    useAnalytics("COURSES_LIST");
    return (
      <>
        <button data-analytics-action="refresh">live</button>
        <button data-analytics-action="page_next" aria-disabled="true">
          soft
        </button>
        <button data-analytics-action="page_previous" disabled>
          hard
        </button>
      </>
    );
  }
  ui = await mount(<Probe />);
  await vi.waitFor(() =>
    expect(
      sendMessage.mock.calls.some(
        ([message]) => message.type === "ANALYTICS_CAPTURE",
      ),
    ).toBe(true),
  );
  for (const button of document.querySelectorAll("button"))
    await act(async () => button.click());
  const actions = sendMessage.mock.calls
    .map(
      ([message]) =>
        message as { type: string; data?: { event: string; action?: string } },
    )
    .filter((message) => message.data?.event === "action_clicked")
    .map((message) => message.data?.action);
  expect(actions).toEqual(["refresh"]);
});
