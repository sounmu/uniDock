import { progressActive, progressText, type ProgressItem, type ProgressText } from "./progress";

const HOST_ID = "unidock-progress";
const FINISHED_MS = 10_000;
const SVG = "http://www.w3.org/2000/svg";
const RING = 59.69;

// A Live Activity capsule: always dark, like Dynamic Island, so it reads the
// same over any LMS page in light or dark mode.
const STYLE = `
:host {
  all: initial;
  position: fixed;
  left: 50%;
  bottom: 20px;
  z-index: 2147483647;
  transform: translateX(-50%);
  --font: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Apple SD Gothic Neo", "Malgun Gothic", system-ui, sans-serif;
  --ink: #ffffff;
  --secondary: rgba(235, 235, 245, 0.6);
  --track: rgba(235, 235, 245, 0.18);
  --brand: #f0a6b6;
  --green: #30d158;
  --red: #ff453a;
}
section {
  display: grid;
  gap: 8px;
  justify-items: center;
  font-family: var(--font);
  -webkit-font-smoothing: antialiased;
}
.capsule {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 260px;
  max-width: min(380px, calc(100vw - 32px));
  height: 52px;
  padding: 0 18px 0 14px;
  border-radius: 26px;
  background: #000;
  color: var(--ink);
  animation: enter 220ms cubic-bezier(0.2, 0.9, 0.3, 1.2);
}
svg {
  width: 26px;
  height: 26px;
  flex: none;
  display: block;
}
.spin {
  animation: spin 1s linear infinite;
  transform-origin: 50% 50%;
}
.text {
  display: grid;
  gap: 1px;
  flex: 1;
  min-width: 0;
}
strong {
  font-size: 14px;
  font-weight: 600;
  letter-spacing: -0.01em;
  line-height: 1.3;
}
.detail {
  overflow: hidden;
  font-size: 12px;
  line-height: 1.3;
  color: var(--secondary);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.end {
  flex: none;
  font-size: 13px;
  font-weight: 600;
  color: var(--secondary);
  font-variant-numeric: tabular-nums;
}
.end[data-percent] {
  font-size: 17px;
  color: var(--brand);
}
button {
  all: unset;
  position: absolute;
  left: -6px;
  top: -6px;
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: #3a3a3c;
  box-shadow: 0 0 0 0.5px rgba(255, 255, 255, 0.16), 0 1px 3px rgba(0, 0, 0, 0.4);
  color: rgba(235, 235, 245, 0.8);
  font: 600 14px/1 var(--font);
  cursor: pointer;
  opacity: 0;
  transition: opacity 120ms ease;
}
.capsule:hover button,
button:focus-visible {
  opacity: 1;
}
button:focus-visible {
  outline: 2px solid var(--brand);
  outline-offset: 2px;
}
.live {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
}
@keyframes enter {
  from { opacity: 0; transform: translateY(10px) scale(0.92); }
}
@keyframes spin {
  to { transform: rotate(360deg); }
}
@media (prefers-reduced-motion: reduce) {
  .capsule, .spin { animation: none; }
  button { transition: none; }
}
`;

function svgNode(doc: Document, name: string, attributes: Record<string, string>): SVGElement {
  const node = doc.createElementNS(SVG, name) as SVGElement;
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  return node;
}

function circle(doc: Document, stroke: string, extra: Record<string, string> = {}): SVGElement {
  return svgNode(doc, "circle", {
    cx: "12",
    cy: "12",
    r: "9.5",
    fill: "none",
    stroke,
    "stroke-width": "3",
    ...extra,
  });
}

function glyph(doc: Document, text: ProgressText): SVGElement {
  const svg = svgNode(doc, "svg", { viewBox: "0 0 24 24", "aria-hidden": "true" });
  if (text.tone === "done") {
    svg.append(
      svgNode(doc, "circle", { cx: "12", cy: "12", r: "11", fill: "var(--green)" }),
      svgNode(doc, "path", {
        d: "m7.2 12.4 3.1 3 6.5-6.6",
        fill: "none",
        stroke: "#fff",
        "stroke-width": "2.4",
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
      }),
    );
  } else if (text.tone === "error") {
    svg.append(
      svgNode(doc, "circle", { cx: "12", cy: "12", r: "11", fill: "var(--red)" }),
      svgNode(doc, "path", {
        d: "M12 6.8v6.4M12 16.6v.2",
        fill: "none",
        stroke: "#fff",
        "stroke-width": "2.6",
        "stroke-linecap": "round",
      }),
    );
  } else if (text.tone === "wait") {
    svg.append(
      circle(doc, "var(--secondary)", { "stroke-width": "2.2" }),
      svgNode(doc, "path", {
        d: "M12 7v5.2l3.4 2",
        fill: "none",
        stroke: "var(--secondary)",
        "stroke-width": "2.2",
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
      }),
    );
  } else {
    const share = text.percent === null ? 0.28 : text.percent / 100;
    const arc = circle(doc, "var(--brand)", {
      "stroke-linecap": "round",
      "stroke-dasharray": `${(RING * share).toFixed(2)} ${RING}`,
      transform: "rotate(-90 12 12)",
    });
    svg.append(circle(doc, "var(--track)"), arc);
    if (text.percent === null) svg.classList.add("spin");
  }
  return svg;
}

/**
 * Toast on LMS pages for work started elsewhere. A finished item is shown only
 * if this page saw it in progress, then hides itself; closing a card hides it
 * until the work reaches its next stage (in progress -> finished).
 */
export function createProgressToast(doc: Document = document) {
  let host: HTMLElement | null = null;
  let list: HTMLElement | null = null;
  let live: HTMLElement | null = null;
  let announced = "";
  let items: readonly ProgressItem[] = [];
  const seenActive = new Set<string>();
  const finished = new Map<string, ReturnType<typeof setTimeout> | null>();
  const dismissed = new Map<string, "active" | "finished">();
  interface Card {
    readonly node: HTMLElement;
    readonly title: HTMLElement;
    readonly detail: HTMLElement;
    readonly end: HTMLElement;
    glyph: SVGElement;
    glyphKey: string;
    stage: "active" | "finished";
  }
  const cards = new Map<string, Card>();

  const createCard = (id: string): Card => {
    const node = doc.createElement("div");
    node.className = "capsule";
    const body = doc.createElement("div");
    body.className = "text";
    const title = doc.createElement("strong");
    const detail = doc.createElement("span");
    detail.className = "detail";
    body.append(title, detail);
    const end = doc.createElement("span");
    end.className = "end";
    const close = doc.createElement("button");
    close.type = "button";
    close.setAttribute("aria-label", "알림 닫기");
    close.textContent = "×";
    const placeholder = svgNode(doc, "svg", { viewBox: "0 0 24 24", "aria-hidden": "true" });
    node.append(placeholder, body, end, close);
    const card: Card = { node, title, detail, end, glyph: placeholder, glyphKey: "", stage: "active" };
    close.addEventListener("click", () => {
      dismissed.set(id, card.stage);
      render();
    });
    return card;
  };

  const shown = () =>
    items.flatMap((item) => {
      const text = progressText(item);
      if (!text) return [];
      const active = progressActive(item);
      if (active) {
        seenActive.add(item.id);
        finished.delete(item.id);
      } else {
        if (!seenActive.has(item.id)) return [];
        if (!finished.has(item.id))
          finished.set(
            item.id,
            setTimeout(() => {
              finished.set(item.id, null);
              render();
            }, FINISHED_MS),
          );
        if (finished.get(item.id) === null) return [];
      }
      const stage = active ? "active" : "finished";
      // A closed card stays closed only for the stage it was closed in, even when
      // the empty state in between never reached this page (playback's id is fixed).
      if (dismissed.get(item.id) === stage) return [];
      dismissed.delete(item.id);
      return [{ item, text, stage }] as const;
    });

  const mount = () => {
    host = doc.createElement("div");
    host.id = HOST_ID;
    const root = host.attachShadow({ mode: "open" });
    const style = doc.createElement("style");
    style.textContent = STYLE;
    list = doc.createElement("section");
    list.setAttribute("aria-label", "uniDock 진행 상황");
    live = doc.createElement("p");
    live.className = "live";
    live.setAttribute("role", "status");
    root.append(style, list, live);
    doc.documentElement.append(host);
  };

  function render() {
    const visible = shown();
    if (!visible.length) {
      host?.remove();
      host = list = live = null;
      cards.clear();
      announced = "";
      return;
    }
    if (!host?.isConnected) {
      mount();
      cards.clear();
    }
    // Cards are updated in place: a re-inserted card would replay its entrance.
    const ids = new Set(visible.map(({ item }) => item.id));
    for (const [id, card] of cards)
      if (!ids.has(id)) {
        card.node.remove();
        cards.delete(id);
      }
    visible.forEach(({ item, text, stage }, index) => {
      let card = cards.get(item.id);
      if (!card) cards.set(item.id, (card = createCard(item.id)));
      card.stage = stage;
      card.node.dataset.tone = text.tone;
      card.title.textContent = text.title;
      // With a percentage on the right, the second line names the source instead.
      card.detail.textContent = text.percent === null ? text.detail : "uniDock";
      card.end.textContent =
        text.percent !== null ? `${text.percent}%` : text.tone === "wait" ? "대기" : "";
      card.end.toggleAttribute("data-percent", text.percent !== null);
      const key = `${text.tone}:${text.percent}`;
      if (key !== card.glyphKey) {
        const next = glyph(doc, text);
        card.glyph.replaceWith(next);
        card.glyph = next;
        card.glyphKey = key;
      }
      const at = list!.children[index];
      if (at !== card.node) list!.insertBefore(card.node, at ?? null);
    });
    // Announce stage changes only, not every progress percentage.
    const titles = visible.map(({ text }) => text.title).join(" · ");
    if (titles !== announced) {
      announced = titles;
      live!.textContent = titles;
    }
  }

  return {
    update(next: readonly ProgressItem[]) {
      items = next;
      for (const id of [...dismissed.keys()])
        if (!next.some((item) => item.id === id)) dismissed.delete(id);
      render();
    },
  };
}
