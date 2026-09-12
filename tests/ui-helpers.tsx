import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, vi } from "vitest";
export async function mount(element: ReactNode) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(element));
  return {
    host,
    render: async (next: ReactNode) => {
      await act(async () => root.render(next));
    },
    unmount: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}
export async function click(label: string, index = 0) {
  const button = [...document.querySelectorAll("button")].filter(
    (button) => button.textContent === label,
  )[index];
  expect(button).toBeDefined();
  await act(async () => button!.click());
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
