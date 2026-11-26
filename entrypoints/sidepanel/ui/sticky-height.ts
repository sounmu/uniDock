import { useLayoutEffect, useState } from "react";

/** Publishes a sticky bar's rendered height as a root CSS variable, so the bars
    stacked under it and the root scroll-padding start below its current size,
    wrapped or not. Pass the returned callback as the bar's `ref`. */
export function useStickyHeight(variable: `--${string}`): (element: HTMLElement | null) => void {
  const [element, setElement] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!element) return;
    const root = document.documentElement;
    const measure = () => root.style.setProperty(variable, `${element.offsetHeight}px`);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
      root.style.removeProperty(variable);
    };
  }, [element, variable]);
  return setElement;
}
