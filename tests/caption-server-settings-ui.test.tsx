// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act } from "react";
import { click, mount } from "./ui-helpers";

const signIn = vi.hoisted(() => vi.fn());
const signOut = vi.hoisted(() => vi.fn());
const getAccount = vi.hoisted(() => vi.fn());
const getWorkerStatus = vi.hoisted(() => vi.fn());
let session: { email: string } | null | undefined;

vi.mock("../entrypoints/sidepanel/useCaptionSession", () => ({
  useCaptionSession: () => session,
}));
vi.mock("../src/caption-server-settings", () => ({
  captionServerOrigin: () => "https://captions.test",
  signIn,
  signOut,
}));
vi.mock("../src/captions/job-client", () => ({ getAccount, getWorkerStatus }));

import { CaptionServerSettings } from "../entrypoints/sidepanel/CaptionServerSettings";

let ui: Awaited<ReturnType<typeof mount>> | undefined;
beforeEach(() => {
  session = null;
  signIn.mockResolvedValue(undefined);
  signOut.mockResolvedValue(undefined);
  getAccount.mockResolvedValue({
    email: "student@example.com",
    quota: { limit: 7, used: 2, reserved: 0, resetsAt: "2026-10-26T15:00:00Z" },
  });
  getWorkerStatus.mockResolvedValue("offline");
});
afterEach(async () => {
  await ui?.unmount();
  ui = undefined;
  vi.clearAllMocks();
});

it("offers Google login when signed out and explains a refused account", async () => {
  ui = await mount(<CaptionServerSettings />);
  expect(ui.host.textContent).toContain("https://captions.test");
  await click("Google 계정으로 로그인");
  expect(signIn).toHaveBeenCalledOnce();
  signIn.mockRejectedValue({ code: "ACCOUNT_NOT_ALLOWED" });
  await click("Google 계정으로 로그인");
  expect(ui.host.textContent).toContain("이 Google 계정으로는");
  expect(getAccount).not.toHaveBeenCalled();
});

it("shows the account, weekly usage and worker state, and logs out", async () => {
  session = { email: "student@example.com" };
  ui = await mount(<CaptionServerSettings />);
  await act(async () => {
    await vi.waitFor(() => expect(getWorkerStatus).toHaveBeenCalled());
  });
  expect(ui.host.textContent).toContain("student@example.com");
  expect(ui.host.textContent).toContain("2 / 7회");
  expect(ui.host.textContent).toContain("꺼져 있음");
  await click("로그아웃");
  expect(signOut).toHaveBeenCalledOnce();
  expect(ui.host.textContent).toContain("로그아웃했습니다");
});
