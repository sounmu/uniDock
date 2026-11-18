import { defineConfig } from "wxt";
import { KOREA_ORIGINS } from "./src/security/origins";
const CAPTION_CDN = KOREA_ORIGINS.captionMedia;
// WXT loads .env, .env.local and mode files into process.env only after this
// module is evaluated, so the flags are read lazily from the hooks below.
// Shell variables override the files. The release ZIP needs both features on.
function buildFlags() {
  // Sequential playback: player content script, playback runtime, alarms grant.
  const playback = process.env.UNIDOCK_PLAYBACK === "1";
  // AI captions: CDN media access and audio upload to the caption server.
  const aiCaptions = process.env.UNIDOCK_AI_CAPTIONS === "1";
  const captionServer = aiCaptions
    ? httpsOrigin("UNIDOCK_CAPTION_SERVER", true)
    : "";
  // Aggregate usage statistics collector; without it the build sends nothing.
  const statsServer = httpsOrigin("UNIDOCK_STATS_SERVER", false);
  // Optional public key that pins the extension ID, so the OAuth redirect URI
  // (https://<id>.chromiumapp.org/) the broker allows stays valid for unpacked
  // builds. The store rejects a manifest key, so `npm run release` drops it.
  const extensionKey =
    aiCaptions && process.env.UNIDOCK_RELEASE !== "1"
      ? process.env.UNIDOCK_EXTENSION_KEY
      : undefined;
  return { playback, aiCaptions, captionServer, statsServer, extensionKey };
}
function httpsOrigin(name: string, required: boolean): string {
  const value = process.env[name];
  if (!value) {
    if (!required) return "";
    throw new Error(
      `UNIDOCK_AI_CAPTIONS=1 requires ${name} as an https origin`,
    );
  }
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new Error(`${name} must be a bare https origin`);
  return url.origin;
}
export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  hooks: {
    "entrypoints:resolved": (_wxt, entrypoints) => {
      if (buildFlags().playback) return;
      for (const entrypoint of entrypoints)
        if (entrypoint.name === "player") entrypoint.skipped = true;
    },
  },
  manifest: () => {
    const { playback, aiCaptions, captionServer, statsServer, extensionKey } =
      buildFlags();
    const connect = [
      statsServer,
      ...(aiCaptions ? [CAPTION_CDN, captionServer] : []),
    ].filter(Boolean);
    return {
      ...(extensionKey ? { key: extensionKey } : {}),
      name: "uniDock",
      description: playback
        ? "고려대 LMS 과제·일정·녹화 강의를 확인하고 강의 자료 일괄 다운로드, 자막 추출, 선택 영상 순차 자동 재생을 지원하는 비공식 학습 도우미."
        : "고려대 LMS 과제·일정·녹화 강의를 확인하고 강의 자료 일괄 다운로드와 자막 추출을 지원하는 비공식 학습 도우미.",
      minimum_chrome_version: "114",
      permissions: [
        "sidePanel",
        "activeTab",
        "scripting",
        "downloads",
        "storage",
        ...(playback ? ["alarms"] : []),
        ...(aiCaptions
          ? ["declarativeNetRequestWithHostAccess", "identity"]
          : []),
      ],
      host_permissions: [
        ...KOREA_ORIGINS.lms.map((origin) => `${origin}/*`),
        `${KOREA_ORIGINS.player}/*`,
      ],
      // Requested only when the user turns on popup auto-close, so adding the
      // portal never re-prompts existing installs on update.
      optional_host_permissions: [
        `${KOREA_ORIGINS.portal}/*`,
        ...(aiCaptions ? [`${CAPTION_CDN}/*`] : []),
      ],
      icons: {
        16: "icons/16.png",
        32: "icons/32.png",
        48: "icons/48.png",
        128: "icons/128.png",
      },
      action: {
        default_title: "uniDock 열기",
        default_icon: { 16: "icons/16.png", 32: "icons/32.png" },
      },
      content_security_policy: {
        extension_pages: `script-src 'self'; object-src 'none'; connect-src ${connect.length ? connect.join(" ") : "'none'"}; base-uri 'none'; form-action 'none'`,
      },
    };
  },
  vite: () => {
    const { playback, aiCaptions, captionServer, statsServer } = buildFlags();
    return {
      define: {
        __UNIDOCK_STATS_SERVER__: JSON.stringify(statsServer),
        __UNIDOCK_PLAYBACK__: JSON.stringify(playback),
        __UNIDOCK_AI_CAPTIONS__: JSON.stringify(aiCaptions),
        __UNIDOCK_CAPTION_SERVER__: JSON.stringify(captionServer),
      },
      build: { target: "chrome114", sourcemap: false },
    };
  },
});
