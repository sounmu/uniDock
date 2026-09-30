declare global {
  /**
   * Replaced at build time by `wxt.config.ts`. It is true only when
   * `UNIDOCK_PLAYBACK=1`, so release builds drop sequential playback code.
   */
  const __UNIDOCK_PLAYBACK__: boolean;
}
export {};
