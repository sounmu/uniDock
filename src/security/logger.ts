const events = ["REQUEST_FAILED", "PANEL_SETUP_FAILED"] as const;
export function safeLog(event: (typeof events)[number]): void {
  if (!events.includes(event)) return;
  // Only fixed event codes; no payload, error object, URL, title, ID or persistence.
  // eslint-disable-next-line no-console
  console.warn(`[uniDock] ${event}`);
}
