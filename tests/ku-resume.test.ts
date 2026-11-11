// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { observeKuResume } from "../src/playback/ku-resume";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function fixture(text = "이전에 시청했던 32:33부터 이어서 보시겠습니까?") {
  document.body.innerHTML = `<div class="confirm-msg-box">
    <div class="confirm-msg-text"></div>
    <div class="confirm-ok-btn" role="button">예</div>
    <div class="confirm-cancel-btn" role="button">아니오</div>
  </div>`;
  const box = document.querySelector<HTMLElement>(".confirm-msg-box");
  const label = document.querySelector(".confirm-msg-text");
  const yes = document.querySelector<HTMLElement>(".confirm-ok-btn");
  const no = document.querySelector<HTMLElement>(".confirm-cancel-btn");
  if (!box || !label || !yes || !no) throw new Error("missing dialog");
  label.textContent = text;
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 100, 40),
  );
  const accepted = vi.fn();
  const declined = vi.fn();
  yes.addEventListener("click", accepted);
  no.addEventListener("click", declined);
  return { box, label, yes, accepted, declined };
}

it.each([
  ["32:33", 1953],
  ["1:12:26", 4346],
] as const)(
  "accepts the saved-position prompt once per display: %s",
  async (position, seconds) => {
    const f = fixture(`이전에 시청했던 ${position}부터 이어서 보시겠습니까?`);
    const acceptedPosition = vi.fn();
    cleanups.push(observeKuResume(document, () => true, acceptedPosition));
    expect(f.accepted).toHaveBeenCalledOnce();
    expect(acceptedPosition).toHaveBeenCalledExactlyOnceWith(seconds);
    expect(f.declined).not.toHaveBeenCalled();
    f.box.classList.add("updated");
    await Promise.resolve();
    expect(f.accepted).toHaveBeenCalledOnce();
    f.box.style.display = "none";
    await Promise.resolve();
    f.box.style.display = "block";
    await Promise.resolve();
    expect(f.accepted).toHaveBeenCalledTimes(2);
  },
);

it.each([
  "이 영상을 삭제하시겠습니까?",
  "이전에 시청했던 32:99부터 이어서 보시겠습니까?",
])("does not accept a different confirmation: %s", (text) => {
  const f = fixture(text);
  cleanups.push(observeKuResume(document, () => true));
  expect(f.accepted).not.toHaveBeenCalled();
});

it("waits for a rendered, unambiguous authorized prompt even in a hidden tab", async () => {
  const f = fixture();
  let authorized = false;
  cleanups.push(observeKuResume(document, () => authorized));
  expect(f.accepted).not.toHaveBeenCalled();
  authorized = true;
  const duplicate = f.box.cloneNode(true);
  document.body.append(duplicate);
  await Promise.resolve();
  expect(f.accepted).not.toHaveBeenCalled();
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "hidden",
  });
  f.box.style.display = "none";
  document.body.removeChild(duplicate);
  await Promise.resolve();
  expect(f.accepted).not.toHaveBeenCalled();
  f.box.style.display = "block";
  await Promise.resolve();
  expect(f.accepted).toHaveBeenCalledOnce();
});

it("cancels queued prompt handling after revocation", async () => {
  const f = fixture();
  f.box.style.display = "none";
  const cleanup = observeKuResume(document, () => true);
  cleanups.push(cleanup);
  f.box.style.display = "block";
  cleanup();
  await Promise.resolve();
  expect(f.accepted).not.toHaveBeenCalled();
});
