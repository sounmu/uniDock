import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  // Unit tests cover the playback code kept in the repository; the release
  // build (flag off) is checked by the Rail tests and scripts/package-release.
  define: {
    __UNIDOCK_PLAYBACK__: "true",
    __UNIDOCK_AI_CAPTIONS__: "true",
    __UNIDOCK_CAPTION_SERVER__: JSON.stringify("https://captions.test"),
    __UNIDOCK_GOOGLE_CLIENT_ID__: JSON.stringify("test-client.apps.googleusercontent.com"),
  },
  test: {
    exclude: [...configDefaults.exclude, "tests/e2e/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.{ts,tsx}", "entrypoints/**/*.{ts,tsx}"],
      exclude: ["**/*.d.ts", "entrypoints/sidepanel/main.tsx"],
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
      },
    },
  },
});
