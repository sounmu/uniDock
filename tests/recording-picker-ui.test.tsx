// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { mount } from "./ui-helpers";
import { QueryGate } from "../entrypoints/sidepanel/query-gate";
import { useRecordingPicker, type RecordingEntry } from "../entrypoints/sidepanel/useRecordingPicker";

const recordings = ["a", "b", "c"].map((handle) => ({
  module: "1주차",
  title: `강의 ${handle}`,
  type: "ExternalTool" as const,
  source: "module" as const,
  lmsHandle: `lms-${handle}`,
  launchHandle: handle,
}));
const entry = {
  course: { id: "1", name: "과목" },
  recordings,
  target: { id: 3, url: "https://mylms.korea.ac.kr/courses/1/modules", documentToken: "token" },
  selectedHandles: ["a", "b", "c"],
} as unknown as RecordingEntry;
const eligible = () => true;
const gate = new QueryGate();
let picker: ReturnType<typeof useRecordingPicker>;
let ui: Awaited<ReturnType<typeof mount>>;

afterEach(async () => {
  await ui?.unmount();
  vi.unstubAllGlobals();
});

function Harness({ limit }: { readonly limit: number }) {
  picker = useRecordingPicker(gate, { eligible, limit }, entry);
  return null;
}

it("keeps only the first picks when today's remaining uses drop", async () => {
  ui = await mount(<Harness limit={3} />);
  expect(picker.recordings.map((item) => item.order)).toEqual([1, 2, 3]);
  await ui.render(<Harness limit={1} />);
  expect(picker.recordings.map((item) => item.order)).toEqual([1, null, null]);
  expect(picker.takeSelection()?.handles).toEqual(["a"]);
});
