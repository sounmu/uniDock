// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { mount } from "./ui-helpers";
import { ProgressStrip } from "../entrypoints/sidepanel/ProgressStrip";
import { Rail } from "../entrypoints/sidepanel/ui/Rail";

let ui: Awaited<ReturnType<typeof mount>> | undefined;
afterEach(async () => {
  await ui?.unmount();
  ui = undefined;
});

it("marks a rail section with work in progress without changing its name", async () => {
  ui = await mount(
    <Rail section="courses" onSelect={() => {}} onInfo={() => {}} active={["home"]} />,
  );
  const button = [...document.querySelectorAll("nav button")].find((b) => b.textContent === "홈")!;
  expect(button.querySelector(".rail-dot")).not.toBeNull();
  expect(document.querySelectorAll(".rail-dot")).toHaveLength(1);
});

it("opens the section of a progress row", async () => {
  const onOpen = vi.fn();
  ui = await mount(
    <ProgressStrip
      activity={[
        {
          section: "captions",
          item: { kind: "captions", id: "job_1", phase: "running", percent: 30, workerOffline: false },
        },
      ]}
      onOpen={onOpen}
    />,
  );
  const row = document.querySelector<HTMLButtonElement>(".progress-row")!;
  expect(row.textContent).toContain("AI 자막 만드는 중");
  expect(row.textContent).toContain("30% 완료");
  await act(async () => row.click());
  expect(onOpen).toHaveBeenCalledWith("captions");
});
