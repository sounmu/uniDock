import { defineConfig } from 'wxt';
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'uniDock', description: '기존 고려대 LMS 로그인 세션으로 과목을 안전하게 조회합니다.',
    minimum_chrome_version: '114', permissions: ['sidePanel', 'activeTab', 'scripting'],
    host_permissions: ['https://mylms.korea.ac.kr/*', 'https://canvas.korea.ac.kr/*'],
    action: { default_title: 'uniDock 열기' },
    content_security_policy: { extension_pages: "script-src 'self'; object-src 'none'" },
  },
  vite: () => ({ build: { target: 'chrome114', sourcemap: false } }),
});
