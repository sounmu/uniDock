import type { ReactNode } from "react";
// Label for a control that opens a new tab: the arrow is decorative and the
// accessible name says "(새 탭)" instead.
export function newTab(label: string): {
  "aria-label": string;
  children: ReactNode;
} {
  return {
    "aria-label": `${label} (새 탭)`,
    children: (
      <>
        {label} <span aria-hidden="true">↗</span>
      </>
    ),
  };
}
// Unlike `disabled`, aria-disabled keeps keyboard focus on a control that
// disables itself in response to its own activation.
export function softDisabled(
  disabled: boolean,
  onClick: () => void,
): { "aria-disabled": boolean | undefined; onClick: () => void } {
  return {
    "aria-disabled": disabled || undefined,
    onClick: () => {
      if (!disabled) onClick();
    },
  };
}
// Focus the control that opened a detail, or the visible screen heading when
// that control has been unmounted meanwhile.
export function restoreFocus(element: Element | null): void {
  if (element instanceof HTMLElement && element.isConnected) {
    element.focus({ preventScroll: true });
    return;
  }
  const heading = [...document.querySelectorAll<HTMLElement>("main h1")].find(
    (h) => h.offsetParent !== null || !h.closest("[hidden]"),
  );
  if (!heading) return;
  if (!heading.hasAttribute("tabindex")) heading.tabIndex = -1;
  heading.focus({ preventScroll: true });
}
// Stable React keys for rows that deliberately carry no LMS identifiers.
const keys = new WeakMap<object, string>();
let nextKey = 0;
export function rowKey(item: object): string {
  let key = keys.get(item);
  if (key === undefined) keys.set(item, (key = `row-${nextKey++}`));
  return key;
}
