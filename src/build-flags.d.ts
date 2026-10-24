declare global {
  /**
   * Replaced at build time by `wxt.config.ts`. It is true only when
   * `UNIDOCK_PLAYBACK=1`, so release builds drop sequential playback code.
   */
  const __UNIDOCK_PLAYBACK__: boolean;
  /**
   * Replaced at build time by `wxt.config.ts`. True only when
   * `UNIDOCK_AI_CAPTIONS=1`, so release builds drop AI caption code.
   */
  const __UNIDOCK_AI_CAPTIONS__: boolean;
  /**
   * The caption server origin baked in at build time from
   * `UNIDOCK_CAPTION_SERVER`. Empty string in release builds.
   */
  const __UNIDOCK_CAPTION_SERVER__: string;
  /**
   * Google OAuth web client ID from `UNIDOCK_GOOGLE_CLIENT_ID` for the AI
   * caption sign-in. Empty string in release builds.
   */
  const __UNIDOCK_GOOGLE_CLIENT_ID__: string;
}
export {};
