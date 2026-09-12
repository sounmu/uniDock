import { defineConfig } from "wxt";
export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  manifest: {
    name: "uniDock",
    description:
      "고려대 LMS 과제·일정·녹화 강의를 조회하고 강의 자막을 TXT·JSON으로 저장하는 비공식 학습 도우미.",
    minimum_chrome_version: "114",
    permissions: ["sidePanel", "activeTab", "scripting", "downloads"],
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
        "script-src 'self'; object-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'",
    },
  },
  vite: () => ({ build: { target: "chrome114", sourcemap: false } }),
});
