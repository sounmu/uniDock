// Synthetic transport only. App, detection, job polling, and downloads run unchanged.
export const captionOrigin = "https://captions.test";
export const captionTranscript = {
  schema_version: 1,
  language: "ko",
  engine: "fixture",
  model_revision: "synthetic-v1",
  pipeline_version: "1",
  created_at: "2026-11-04T00:00:00Z",
  expires_at: "2027-05-04T00:00:00Z",
  duration_ms: 12000,
  segments: [
    {
      start_ms: 0,
      end_ms: 4000,
      text: "오늘은 해시 테이블의 원리를 살펴보겠습니다.",
    },
    {
      start_ms: 4000,
      end_ms: 8000,
      text: "해시 함수는 키를 배열의 인덱스로 변환합니다.",
    },
    {
      start_ms: 8000,
      end_ms: 12000,
      text: "충돌은 체이닝으로 해결할 수 있습니다.",
    },
  ],
};

// Installed before the real sidepanel/main.tsx loads in a fresh browser context.
export function installCaptionFixture() {
  const pageUrl = "https://kucom.korea.ac.kr/em/site-caption-fixture";
  const tab = {
    id: 7,
    windowId: 1,
    url: pageUrl,
    title: "자료구조 · 해시 테이블",
  };
  const values = {
    "unidock.caption-session.v1": {
      id: "site-fixture-session-0001",
      loginId: "site-fixture-login-000001",
      accessToken: "synthetic-access-token",
      accessExpiresAt: "2099-01-01T00:00:00Z",
      refreshToken: "synthetic-refresh-token",
      refreshExpiresAt: "2099-01-01T00:00:00Z",
      email: "demo@example.test",
    },
    "unidock.caption-install-salt.v1": "ab".repeat(32),
    ...JSON.parse(globalThis.sessionStorage.getItem("site-caption-storage") ?? "{}"),
  };
  const event = { addListener() {}, removeListener() {} };
  // This mutable ledger records actual exported Blob bodies, not expected data.
  const evidence = { downloads: [], injections: [] };
  globalThis.__siteCaptionFixture = evidence;
  const storage = {
    get: async (key) => ({ [key]: values[key] }),
    set: async (patch) => {
      Object.assign(values, patch);
      globalThis.sessionStorage.setItem("site-caption-storage", JSON.stringify(values));
    },
    remove: async (key) => {
      delete values[key];
    },
  };
  globalThis.chrome = {
    runtime: {
      getManifest: () => ({ version: "0.5.2" }),
      sendMessage: async (message) => {
        if (message.type === "UPDATE_NOTICE_TAKE") return { updated: false };
        if (message.type === "ANALYTICS_STATUS")
          return { available: false, enabled: false, notice: null };
        throw new Error(`Unexpected fixture message: ${message.type}`);
      },
    },
    storage: { local: storage, session: storage, onChanged: event },
    tabs: {
      query: async () => [tab],
      get: async () => tab,
      onUpdated: event,
      onRemoved: event,
    },
    permissions: { request: async () => true },
    scripting: {
      executeScript: async ({ world, args }) => {
        evidence.injections.push({ world, args });
        const result = args
          ? {
              pageUrl,
              pageTitle: tab.title,
              items: [],
              blocked: false,
              limited: false,
            }
          : world === "ISOLATED"
            ? pageUrl
            : {
                mediaUrl:
                  "https://korea-cms-object.cdn.gov-ntruss.com/contents7/kruniv1001/0000000000001/contents/media_files/fixture.mp4",
                durationS: 12,
                contentId: "0000000000001",
              };
        return [{ frameId: 0, documentId: "site-fixture-document", result }];
      },
    },
    downloads: {
      onCreated: event,
      onChanged: event,
      download: async ({ url, filename }) => {
        const body = await (await globalThis.fetch(url)).text();
        evidence.downloads.push({ filename, body });
        return evidence.downloads.length;
      },
    },
  };
}
