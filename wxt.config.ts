import { defineConfig } from "wxt";
// Sequential playback is under review. Release builds leave it out entirely:
// no player content script, no playback runtime, and no alarms grant.
const playback = process.env.UNIDOCK_PLAYBACK === "1";
// AI caption generation is a development-only build. Release packaging rejects
// UNIDOCK_AI_CAPTIONS=1, so the CDN media access and server upload code never
// ship to the store.
const aiCaptions = process.env.UNIDOCK_AI_CAPTIONS === "1";
const CAPTION_CDN = "https://korea-cms-object.cdn.gov-ntruss.com";
const captionServer = aiCaptions ? captionServerOrigin() : "";
const googleClientId = aiCaptions ? captionGoogleClientId() : "";
// Optional public key that pins the extension ID, so the OAuth redirect URI
// (https://<id>.chromiumapp.org/) and the server's CORS allowlist stay valid.
const extensionKey = aiCaptions ? process.env.UNIDOCK_EXTENSION_KEY : undefined;
function captionGoogleClientId(): string {
  const value = process.env.UNIDOCK_GOOGLE_CLIENT_ID ?? "";
  if (!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(value))
    throw new Error(
      "UNIDOCK_AI_CAPTIONS=1 requires UNIDOCK_GOOGLE_CLIENT_ID (a Google OAuth web client ID)",
    );
  return value;
}
function captionServerOrigin(): string {
  const value = process.env.UNIDOCK_CAPTION_SERVER;
  if (!value)
    throw new Error(
      "UNIDOCK_AI_CAPTIONS=1 requires UNIDOCK_CAPTION_SERVER as an https origin",
    );
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new Error("UNIDOCK_CAPTION_SERVER must be a bare https origin");
  return url.origin;
}
export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  hooks: {
    "entrypoints:resolved": (_wxt, entrypoints) => {
      if (playback) return;
      for (const entrypoint of entrypoints)
        if (entrypoint.name === "player") entrypoint.skipped = true;
    },
  },
  manifest: {
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
      ...(aiCaptions ? ["declarativeNetRequestWithHostAccess", "identity"] : []),
    ],
    host_permissions: [
      "https://mylms.korea.ac.kr/*",
      "https://canvas.korea.ac.kr/*",
      "https://kucom.korea.ac.kr/*",
    ],
    // Requested only when the user turns on popup auto-close, so adding the
    // portal never re-prompts existing installs on update.
    optional_host_permissions: [
      "https://lms.korea.ac.kr/*",
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
      extension_pages: `script-src 'self'; object-src 'none'; connect-src https://eu.i.posthog.com${aiCaptions ? ` ${CAPTION_CDN} ${captionServer}` : ""}; base-uri 'none'; form-action 'none'`,
    },
  },
  vite: () => ({
    define: {
      __UNIDOCK_PLAYBACK__: JSON.stringify(playback),
      __UNIDOCK_AI_CAPTIONS__: JSON.stringify(aiCaptions),
      __UNIDOCK_CAPTION_SERVER__: JSON.stringify(captionServer),
      __UNIDOCK_GOOGLE_CLIENT_ID__: JSON.stringify(googleClientId),
    },
    build: { target: "chrome114", sourcemap: false },
  }),
});
