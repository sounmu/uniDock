/**
 * Which browser windows have a uniDock panel page open. A panel page (the side
 * panel, the popup fallback or `sidepanel.html` in a tab) holds one port for as
 * long as it lives. Chrome 114 has no side panel open or close event, so the
 * port's disconnect is the only signal that a panel closed.
 */
export const PANEL_PORT = "unidock-panel";
/** Under the 30 s service worker idle limit: a message on the port keeps the worker running. */
export const PANEL_ALIVE_MS = 25_000;

const PORT_NAME = /^unidock-panel:(\d{1,10})$/;

export function panelPortWindow(name: string): number | null {
  const id = PORT_NAME.exec(name)?.[1];
  return id === undefined ? null : Number(id);
}

interface Panel {
  windowId: number;
  /** Set for a panel page opened in a tab, which can move to another window. */
  readonly tabId: number | undefined;
}

export class PanelPresence {
  private readonly panels = new Map<chrome.runtime.Port, Panel>();

  constructor(private readonly onChange: (windows: ReadonlySet<number>) => void) {}

  /** Only for a port whose sender passed `panelSender`. */
  connect(port: chrome.runtime.Port, windowId: number): void {
    this.panels.set(port, { windowId, tabId: port.sender?.tab?.id });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      this.panels.delete(port);
      this.changed();
    });
    try {
      // The page reopens only a port that was accepted.
      port.postMessage({ type: "ready" });
    } catch {
      // A page closing meanwhile disconnects the port.
    }
    this.changed();
  }

  tabMoved(tabId: number, windowId: number): void {
    let moved = false;
    for (const panel of this.panels.values())
      if (panel.tabId === tabId && panel.windowId !== windowId) {
        panel.windowId = windowId;
        moved = true;
      }
    if (moved) this.changed();
  }

  private changed(): void {
    this.onChange(new Set([...this.panels.values()].map((panel) => panel.windowId)));
  }
}

/**
 * Panel page side: holds the port while the page lives. A worker that stops
 * drops the port, so an accepted port is opened again at once and the restarted
 * worker learns this window anew. A port that was never accepted (a refused
 * sender, a worker without the listener) is not retried.
 */
export function announcePanel(): void {
  const open = async (): Promise<void> => {
    // Asked on every connection: a panel page in a tab may have changed windows.
    const { id } = await chrome.windows.getCurrent();
    if (id === undefined || id < 0) return;
    const port = chrome.runtime.connect({ name: `${PANEL_PORT}:${id}` });
    let alive: ReturnType<typeof setInterval> | undefined;
    port.onMessage.addListener(() => {
      alive ??= setInterval(() => {
        try {
          port.postMessage({ type: "alive" });
        } catch {
          // A dropped port is reopened by its onDisconnect handler.
        }
      }, PANEL_ALIVE_MS);
    });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      if (alive === undefined) return;
      clearInterval(alive);
      start();
    });
  };
  const start = () => void open().catch(() => {});
  start();
}
