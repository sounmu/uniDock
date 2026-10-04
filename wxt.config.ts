import { defineConfig } from "wxt";
// Sequential playback is under review. Release builds leave it out entirely:
// no player content script, no playback runtime, and no alarms grant.
const playback = process.env.UNIDOCK_PLAYBACK === "1";
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
    ],
    host_permissions: [
      "https://mylms.korea.ac.kr/*",
      "https://canvas.korea.ac.kr/*",
      "https://kucom.korea.ac.kr/*",
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
      extension_pages:
        "script-src 'self'; object-src 'none'; connect-src https://eu.i.posthog.com; base-uri 'none'; form-action 'none'",
    },
  },
  vite: () => ({
    define: { __UNIDOCK_PLAYBACK__: JSON.stringify(playback) },
    build: { target: "chrome114", sourcemap: false },
  }),
});
