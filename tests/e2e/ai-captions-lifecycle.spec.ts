import { expect, test, type BrowserContext, type Page, type Worker } from "@playwright/test";
import { createServer } from "node:https";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createFile, MP4BoxBuffer, type Movie } from "mp4box";
import { aiCaptionsBuild, AI_CAPTIONS_SKIP_REASON } from "./build-shape";
import { CAPTION_RULE_SWEEP_GRACE_MS } from "../../src/captions/referer-rule";

const extensionPath = path.resolve(".output/chrome-mv3");
const CDN_HOST = "korea-cms-object.cdn.gov-ntruss.com";
const CDN_PATH =
  "/contents7/kruniv1001/0123456789abc/contents/media_files/screen.mp4";
const CDN_URL = `https://${CDN_HOST}${CDN_PATH}`;
const TOKEN = `e2e-access-${"x".repeat(32)}`;
const SESSION_KEY = "unidock.caption-session.v1";
const JOB_ID = "0193c0de-7a1b-7c2d-8e3f-00000000e2e0";
const TRANSCRIPT_ID = "0193c0de-7a1b-7c2d-8e3f-00000000e2e1";
const stages = ["extracting", "uploading", "polling"] as const;
type Stage = (typeof stages)[number];

function responseGate() {
  let reached!: () => void;
  let release!: () => void;
  const arrived = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("response gate not reached")), 20_000);
    reached = () => {
      clearTimeout(timeout);
      resolve();
    };
  });
  const released = new Promise<void>((resolve) => (release = resolve));
  return { arrived, reached, released, release };
}

interface CdnHit {
  referer: string | undefined;
  range: string | undefined;
  status: number;
}

function parseMp4(bytes: Buffer) {
  const file = createFile();
  let info: Movie | undefined;
  file.onReady = (value: Movie) => (info = value);
  const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  file.appendBuffer(MP4BoxBuffer.fromArrayBuffer(copy, 0));
  file.flush();
  if (!info) throw new Error("not an MP4");
  const movie = info as Movie;
  const samples = (id: number) =>
    file.getTrackById(id).samples.map((s) => ({ offset: s.offset, size: s.size }));
  return { movie, samples };
}

async function fakeServices(directory: string) {
  const key = path.join(directory, "key.pem");
  const cert = path.join(directory, "cert.pem");
  await promisify(execFile)("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key,
    "-out", cert, "-days", "1", "-subj", "/CN=kucom.korea.ac.kr",
  ]);
  const media = await readFile(path.resolve("tests/fixtures/media/tail.mp4"));
  const cdn: CdnHit[] = [];
  const uploads: Buffer[] = [];
  const idempotencyKeys: string[] = [];
  let cancels = 0;
  let received: Buffer[] = [];
  let declaredLength: number | undefined;
  let refuseQuota = false;
  const holds = new Map<Stage, ReturnType<typeof responseGate>>();
  const gates: ReturnType<typeof responseGate>[] = [];
  const polls: string[] = [];
  const transcripts: string[] = [];
  const pause = async (stage: Stage) => {
    const held = holds.get(stage);
    if (!held) return;
    holds.delete(stage);
    held.reached();
    await held.released;
  };
  const holdNextResponse = (stage: Stage) => {
    const gate = responseGate();
    holds.set(stage, gate);
    gates.push(gate);
    return gate;
  };
  let refuseMultipart = false;

  const server = createServer(
    { key: await readFile(key), cert: await readFile(cert) },
    async (request, response) => {
      const host = (request.headers.host ?? "").split(":")[0];
      const url = new URL(request.url ?? "/", `https://${host}`);
      if (host === "kucom.korea.ac.kr") {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(`<!doctype html><html><title>Fake KU player</title><body>
          <main>Fake KU player without captions</main>
          <script>
            window.uniPlayerConfig = { _contentPlayingInfoData: { duration: 3, storyList: [
              { isIntro: true, mainMediaList: { list: [] } },
              { isIntro: false, mainMediaList: { list: [{ desktopMediaUri: ${JSON.stringify(CDN_URL)} }] } }
            ] } };
          </script></body></html>`);
        return;
      }
      if (host === CDN_HOST) {
        const referer = request.headers.referer;
        const range = request.headers.range;
        if (url.pathname !== CDN_PATH) {
          response.writeHead(404);
          response.end();
          return;
        }
        if (referer !== "https://kucom.korea.ac.kr/") {
          cdn.push({ referer, range, status: 403 });
          response.writeHead(403);
          response.end("missing referer");
          return;
        }
        const specs = /^bytes=\d+-\d+(,\d+-\d+)*$/.test(range ?? "")
          ? range!.slice(6).split(",").map((s) => s.split("-").map(Number) as [number, number])
          : [];
        if (!specs.length || (specs.length > 1 && refuseMultipart)) {
          cdn.push({ referer, range, status: 416 });
          response.writeHead(416);
          response.end();
          return;
        }
        cdn.push({ referer, range, status: 206 });
        await pause("extracting");
        if (specs.length > 1) {
          // Same shape as the live KU CDN, including its leading CRLF.
          const boundary = "E2EBOUND";
          const body = Buffer.concat([
            ...specs.flatMap(([s, e]) => [
              Buffer.from(`\r\n--${boundary}\r\nContent-Type: video/mp4\r\nContent-Range: bytes ${s}-${e}/${media.length}\r\n\r\n`),
              media.subarray(s, e + 1),
            ]),
            Buffer.from(`\r\n--${boundary}--\r\n`),
          ]);
          response.writeHead(206, {
            "Content-Type": `multipart/byteranges; boundary=${boundary}`,
            "Content-Length": body.length,
          });
          response.end(body);
          return;
        }
        const [start, requestedEnd] = specs[0]!;
        const end = Math.min(requestedEnd, media.length - 1);
        response.writeHead(206, {
          "Content-Type": "video/mp4",
          "Content-Range": `bytes ${start}-${end}/${media.length}`,
          "Content-Length": end - start + 1,
        });
        response.end(media.subarray(start, end + 1));
        return;
      }
      if (host === "captions.test") {
        response.setHeader("Access-Control-Allow-Origin", request.headers.origin ?? "*");
        response.setHeader(
          "Access-Control-Allow-Headers",
          "authorization, content-type, idempotency-key, tus-resumable, upload-offset, upload-length",
        );
        response.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, HEAD, PATCH");
        response.setHeader(
          "Access-Control-Expose-Headers",
          "upload-offset, upload-length, upload-defer-length, tus-resumable, retry-after, location",
        );
        if (request.method === "OPTIONS") {
          response.writeHead(204);
          response.end();
          return;
        }
        const json = (body: unknown, status = 200) => {
          response.writeHead(status, { "Content-Type": "application/json" });
          response.end(JSON.stringify(body));
        };
        if (request.headers.authorization !== `Bearer ${TOKEN}`)
          return json({ error: { code: "UNAUTHENTICATED" } }, 401);
        const audioPath = `/v1/transcription-jobs/${JOB_ID}/audio`;
        const done = uploads.length > 0;
        const job = () => ({
          id: JOB_ID,
          state: done ? "succeeded" : "awaiting_upload",
          upload: {
            url: audioPath,
            offset: received.reduce((n, b) => n + b.length, 0),
            ...(declaredLength ? { size_bytes: declaredLength } : {}),
            chunk_size: 8388608,
          },
          ...(done ? { transcript_id: TRANSCRIPT_ID } : {}),
          created_at: "2026-10-24T00:00:00Z",
          updated_at: "2026-10-24T00:00:00Z",
        });
        if (url.pathname === "/v1/service-status") return json({ worker: "online" });
        if (request.method === "POST" && url.pathname === "/v1/transcription-jobs") {
          if (refuseQuota)
            return json({ error: { code: "QUOTA_EXCEEDED", retry_after_s: 3600 } }, 429);
          idempotencyKeys.push(String(request.headers["idempotency-key"]));
          return json(job(), 201);
        }
        if (url.pathname === `/v1/transcription-jobs/${JOB_ID}`) {
          polls.push(url.pathname);
          const status = job();
          await pause("polling");
          return json(status);
        }
        if (url.pathname === audioPath) {
          const offset = received.reduce((n, b) => n + b.length, 0);
          if (request.method === "HEAD") {
            response.writeHead(200, {
              "Tus-Resumable": "1.0.0",
              "Upload-Offset": String(offset),
              ...(declaredLength
                ? { "Upload-Length": String(declaredLength) }
                : { "Upload-Defer-Length": "1" }),
            });
            response.end();
            return;
          }
          if (Number(request.headers["upload-offset"]) !== offset)
            return json({ error: { code: "UPLOAD_OFFSET_MISMATCH" } }, 409);
          declaredLength ??= Number(request.headers["upload-length"]);
          const chunks: Buffer[] = [];
          for await (const chunk of request) chunks.push(chunk as Buffer);
          received.push(Buffer.concat(chunks));
          const next = offset + chunks.reduce((n, b) => n + b.length, 0);
          if (next === declaredLength) {
            uploads.push(Buffer.concat(received));
            received = [];
          }
          await pause("uploading");
          response.writeHead(204, { "Tus-Resumable": "1.0.0", "Upload-Offset": String(next) });
          response.end();
          return;
        }
        if (url.pathname === `/v1/transcription-jobs/${JOB_ID}/cancel`) {
          cancels++;
          return json(job());
        }
        if (url.pathname === `/v1/transcripts/${TRANSCRIPT_ID}`) {
          transcripts.push(url.pathname);
          return json({
            schema_version: 1,
            id: TRANSCRIPT_ID,
            language: "ko",
            engine: "fake-engine",
            model_revision: "e2e",
            pipeline_version: "1",
            created_at: "2026-10-23T00:00:00Z",
            expires_at: "2099-01-01T00:00:00Z",
            duration_ms: 3000,
            segments: [{ start_ms: 0, end_ms: 1500, text: "합성 자막 문장" }],
          });
        }
      }
      response.writeHead(404);
      response.end();
    },
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  return {
    port: address.port,
    media,
    cdn,
    uploads,
    idempotencyKeys,
    polls,
    transcripts,
    cancels: () => cancels,
    refuseMultipart: () => {
      refuseMultipart = true;
    },
    refuseQuota: () => {
      refuseQuota = true;
    },
    holdNextResponse,
    holdNextCdnResponse: () => holdNextResponse("extracting"),
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const gate of gates) {
          gate.reached();
          gate.release();
        }
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}

const captionRules = (worker: Worker) =>
  worker.evaluate(async () =>
    (await chrome.declarativeNetRequest.getSessionRules()).map((rule) => ({
      id: rule.id,
      urlFilter: rule.condition.urlFilter,
      referer: rule.action.requestHeaders?.[0]?.value,
    })),
  );

test.describe("AI caption lifecycle against a fake player, CDN and server", () => {
  test.skip(() => !aiCaptionsBuild(), AI_CAPTIONS_SKIP_REASON);

  let profile: string;
  let services: Awaited<ReturnType<typeof fakeServices>>;
  let context: BrowserContext;
  let worker: Worker;
  let extensionId: string;

  test.beforeEach(async ({ playwright }) => {
    profile = await mkdtemp(path.join(tmpdir(), "unidock-ai-captions-"));
    services = await fakeServices(profile);
    const map = ["kucom.korea.ac.kr", CDN_HOST, "captions.test"]
      .map((host) => `MAP ${host} 127.0.0.1:${services.port}`)
      .join(", ");
    context = await playwright.chromium.launchPersistentContext(profile, {
      channel: "chromium",
      headless: true,
      ignoreHTTPSErrors: true,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        `--host-resolver-rules=${map}, MAP * ~NOTFOUND`,
        "--no-proxy-server",
        "--ignore-certificate-errors",
      ],
    });
    worker =
      context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
    extensionId = new URL(worker.url()).host;
    await worker.evaluate(
      ([key, token]) =>
        chrome.storage.local.set({
          [key]: {
            id: "e2e-session-00000001",
            loginId: "e2e-login-000000001",
            accessToken: token,
            accessExpiresAt: "2099-01-01T00:00:00Z",
            refreshToken: `e2e-refresh-${"y".repeat(32)}`,
            refreshExpiresAt: "2099-02-01T00:00:00Z",
            email: "e2e@example.com",
          },
        }),
      [SESSION_KEY, TOKEN] as const,
    );
    // Headless Chrome cannot answer the optional host prompt; grant it the
    // way chrome://extensions does so the panel's request resolves silently.
    const settings = await context.newPage();
    await settings.goto(`chrome://extensions/?id=${extensionId}`);
    await settings.evaluate(
      ([id, host]) =>
        (
          chrome as unknown as {
            developerPrivate: { addHostPermission(id: string, host: string): Promise<void> };
          }
        ).developerPrivate.addHostPermission(id, host),
      [extensionId, `https://${CDN_HOST}/*`] as const,
    );
    await settings.close();
  });

  test.afterEach(async () => {
    await context?.close();
    await services?.close();
    await rm(profile, { recursive: true, force: true });
  });

  async function detectOnPlayer() {
    const player = await context.newPage();
    // Media identification only reads the KU player document under /em/.
    await player.goto("https://kucom.korea.ac.kr/em/lecture");
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await player.bringToFront();
    await panel.getByRole("button", { name: "자막 추출", exact: true }).click();
    await panel.getByRole("button", { name: "자막 감지" }).click();
    return { player, panel };
  }

  async function openPanelOnPlayer() {
    const opened = await detectOnPlayer();
    await opened.panel.getByRole("button", { name: "AI 자막 생성" }).click();
    return opened;
  }

  async function activateTab(page: Page) {
    // Register the actual Chrome activation event before changing the active tab.
    await worker.evaluate(async (url) => {
      const tab = (await chrome.tabs.query({})).find((candidate) => candidate.url === url);
      if (tab?.id === undefined) throw new Error(`tab not found: ${url}`);
      const tabId = tab.id;
      const active = await chrome.tabs.query({ active: true, windowId: tab.windowId });
      if (active[0]?.id === tabId) throw new Error("expected a different active tab");
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timeout);
          chrome.tabs.onActivated.removeListener(activated);
        };
        const activated = (info: { tabId: number; windowId: number }) => {
          if (info.tabId !== tabId) return;
          cleanup();
          resolve();
        };
        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error("tab activation event not received"));
        }, 10_000);
        chrome.tabs.onActivated.addListener(activated);
        void chrome.tabs.update(tabId, { active: true }).catch((error: unknown) => {
          cleanup();
          reject(error);
        });
      });
    }, page.url());
  }

  for (const stage of stages) {
    test(`${stage} survives internal menu round trips and browser tab activation`, async () => {
      // Given a real extraction/upload/poll request paused at its response.
      const other = await context.newPage();
      await other.goto("https://kucom.korea.ac.kr/em/unrelated");
      const { player, panel } = await openPanelOnPlayer();
      const held = services.holdNextResponse(stage);
      await panel.getByRole("button", { name: "음성 보내기" }).click();
      await held.arrived;

      // When both internal navigation and real Chrome tab activation round-trip.
      for (const menu of ["내 과목", "설정"]) {
        await panel.getByRole("button", { name: menu, exact: true }).click();
        await expect(panel.getByRole("button", { name: "취소", exact: true })).toBeHidden();
        await activateTab(other);
        await activateTab(player);
        await panel.getByRole("button", { name: "자막 추출", exact: true }).click();
        await expect(panel.getByRole("button", { name: "취소", exact: true })).toBeVisible();
        expect(services.cancels()).toBe(0);
        expect(services.idempotencyKeys).toHaveLength(1);
      }
      const transcript = context.waitForEvent("response", {
        predicate: (response) =>
          response.url() === `https://captions.test/v1/transcripts/${TRANSCRIPT_ID}` &&
          response.request().method() === "GET",
        timeout: 20_000,
      });
      held.release();

      // Then the original run publishes its final transcript, without restarting.
      expect((await transcript).status()).toBe(200);
      await expectFinished(panel, []);
      expect(services.idempotencyKeys).toHaveLength(1);
      expect(services.polls).toHaveLength(1);
      expect(services.transcripts).toHaveLength(1);
      expect(services.cancels()).toBe(0);
      expect(services.cdn.every((hit) => hit.status === 206)).toBe(true);
      expectAudioOnly(services.cdn);
      expectUploadedAudio();
    });
  }

  for (const sourceChange of ["navigation", "reload", "close"] as const) {
    for (const stage of stages) {
      test(`source ${sourceChange} invalidates ${stage} without publishing a late result`, async () => {
        // Given an accepted job with a response still held by the fake service.
        const { player, panel } = await openPanelOnPlayer();
        const held = services.holdNextResponse(stage);
        await panel.getByRole("button", { name: "음성 보내기" }).click();
        await held.arrived;
        expect(services.idempotencyKeys).toHaveLength(1);
        const aborted = context.waitForEvent("requestfailed", {
          predicate: (request) => {
            switch (stage) {
              case "extracting":
                return request.url() === CDN_URL && request.method() === "GET";
              case "uploading":
                return request.url() === `https://captions.test/v1/transcription-jobs/${JOB_ID}/audio` &&
                  request.method() === "PATCH";
              case "polling":
                return request.url() === `https://captions.test/v1/transcription-jobs/${JOB_ID}` &&
                  request.method() === "GET";
            }
          },
          timeout: 10_000,
        });
        const cancelled = context.waitForEvent("response", {
          predicate: (response) =>
            response.url() === `https://captions.test/v1/transcription-jobs/${JOB_ID}/cancel` &&
            response.request().method() === "POST",
          timeout: 10_000,
        });

        // When the source document is lost, not merely deactivated.
        switch (sourceChange) {
          case "navigation":
            await player.goto("https://kucom.korea.ac.kr/em/another-lecture");
            break;
          case "reload":
            await player.reload();
            break;
          case "close":
            await player.close();
            break;
        }
        const [failedRequest, cancelResponse] = await Promise.all([aborted, cancelled]);
        expect(failedRequest.failure()).not.toBeNull();
        expect(cancelResponse.status()).toBe(200);
        // CaptionsPanel clears the source offer; useAiCaptions must cancel the
        // already-created job before that child unmounts (even during extraction).
        await expect(panel.locator(".ai-offer")).toHaveCount(0);
        held.release();

        // Then even the held success response cannot advance the aborted run.
        await expect(
          panel.getByRole("button", { name: "AI 자막 TXT·JSON 다운로드" }),
        ).toHaveCount(0);
        expect(services.cancels()).toBe(1);
        expect(services.idempotencyKeys).toHaveLength(1);
        expect(services.uploads).toHaveLength(stage === "extracting" ? 0 : 1);
        expect(services.polls).toHaveLength(stage === "polling" ? 1 : 0);
        expect(services.transcripts).toHaveLength(0);
        expectAudioOnly(services.cdn);
        if (stage !== "extracting") expectUploadedAudio();
        await expect.poll(() => captionRules(worker)).toEqual([]);
      });
    }
  }

  const probe = (panel: import("@playwright/test").Page) =>
    panel.evaluate(async (url) => {
      try {
        const response = await fetch(url, {
          headers: { Range: "bytes=0-15" },
          credentials: "omit",
          cache: "no-store",
          redirect: "error",
          referrerPolicy: "no-referrer",
        });
        return response.status;
      } catch (error) {
        return String(error);
      }
    }, CDN_URL);

  test("the session rule alone turns the CDN's 403 into 206 and only audio is uploaded", async () => {
    const { panel } = await openPanelOnPlayer();
    const logs: string[] = [];
    panel.on("console", (m) => logs.push(m.text()));
    await probe(panel);
    expect(services.cdn).toEqual([
      { referer: undefined, range: "bytes=0-15", status: 403 },
    ]);
    expect(await captionRules(worker)).toEqual([]);

    const held = services.holdNextCdnResponse();
    await panel.getByRole("button", { name: "음성 보내기" }).click();
    await held.arrived;
    const during = await captionRules(worker);
    expect(during).toHaveLength(1);
    expect(during[0]).toMatchObject({
      urlFilter: `|${CDN_URL}|`,
      referer: "https://kucom.korea.ac.kr/",
    });
    held.release();

    await expectFinished(panel, logs);
    await expect.poll(() => captionRules(worker)).toEqual([]);
    await probe(panel);
    expect(services.cdn.at(-1)).toEqual({
      referer: undefined,
      range: "bytes=0-15",
      status: 403,
    });

    const jobHits = services.cdn.slice(1, -1);
    expect(jobHits.length).toBeGreaterThan(0);
    expect(jobHits.every((hit) => hit.status === 206 && hit.range)).toBe(true);
    // Audio ranges travel as multipart batches, not one request per range.
    expect(jobHits.some((hit) => hit.range!.includes(","))).toBe(true);
    expectAudioOnly(jobHits);
    expectUploadedAudio();
    expect(services.idempotencyKeys).toHaveLength(1);
    expect(services.idempotencyKeys[0]).toMatch(/^unidock-[0-9a-f]{40}$/);
    expect(services.idempotencyKeys[0]).not.toContain("0123456789abc");
  });

  test("a CDN without multipart support falls back to single ranges and still uploads only audio", async () => {
    services.refuseMultipart();
    const { panel } = await openPanelOnPlayer();
    const logs: string[] = [];
    panel.on("console", (m) => logs.push(m.text()));
    await panel.getByRole("button", { name: "음성 보내기" }).click();
    await expectFinished(panel, logs);
    const refused = services.cdn.filter((hit) => hit.status === 416);
    // One unsupported multipart attempt, then per-range requests only.
    expect(refused).toHaveLength(1);
    expect(refused[0]!.range).toContain(",");
    const after = services.cdn.slice(services.cdn.indexOf(refused[0]!) + 1);
    expect(after.length).toBeGreaterThan(1);
    expect(after.every((hit) => hit.status === 206 && !hit.range!.includes(","))).toBe(true);
    expectAudioOnly(services.cdn);
    expectUploadedAudio();
  });

  async function expectFinished(panel: import("@playwright/test").Page, logs: string[]) {
    await expect(
      panel.getByRole("button", { name: "AI 자막 TXT·JSON 다운로드" }),
    ).toBeVisible({ timeout: 20_000 }).catch((error) => {
      throw new Error(`${error}\nPANEL: ${logs.join(" | ")}\nCDN: ${JSON.stringify(services.cdn.slice(0, 5))}`);
    });
  }

  // No requested range, single or inside a multipart batch, touches a video sample.
  function expectAudioOnly(hits: readonly CdnHit[]) {
    const source = parseMp4(services.media);
    const video = source.movie.videoTracks[0]!;
    const ranges = hits
      .filter((hit) => hit.range)
      .flatMap((hit) => hit.range!.slice(6).split(",").map((s) => s.split("-").map(Number)));
    for (const sample of source.samples(video.id))
      for (const [s, e] of ranges)
        expect(s! < sample.offset + sample.size && e! >= sample.offset).toBe(false);
  }

  function expectUploadedAudio() {
    const source = parseMp4(services.media);
    expect(services.uploads).toHaveLength(1);
    const uploaded = parseMp4(services.uploads[0]!).movie;
    expect(uploaded.tracks).toHaveLength(1);
    expect(uploaded.videoTracks).toHaveLength(0);
    expect(uploaded.audioTracks[0]!.nb_samples).toBe(
      source.movie.audioTracks[0]!.nb_samples,
    );
  }

  test("more than 20 worker restarts mid-capture keep the rule and the job still completes", async () => {
    test.setTimeout(120_000);
    // Opened before the job so it is not a tab event while the job runs.
    const internals = await context.newPage();
    await internals.goto("chrome://serviceworker-internals/");
    const thread = async () =>
      /Renderer thread ID: (\d+)/.exec(await internals.locator("body").innerText())?.[1];
    const { panel } = await openPanelOnPlayer();
    const panelRules = () =>
      panel.evaluate(async () =>
        (await chrome.declarativeNetRequest.getSessionRules()).map((rule) => rule.id),
      );
    const held = services.holdNextCdnResponse();
    await panel.getByRole("button", { name: "음성 보내기" }).click();
    await held.arrived;
    const ruleIds = await panelRules();
    expect(ruleIds).toHaveLength(1);

    // The earlier fix stopped reconnecting after 20 restarts in one job.
    for (let restart = 0; restart < 22; restart++) {
      const previous = await thread();
      await internals.getByRole("button", { name: "Stop" }).first().click();
      await expect.poll(thread).not.toBe(previous);
    }
    const before = await thread();
    await internals.getByRole("button", { name: "Stop" }).first().click();
    // Wake the new worker explicitly too, as any extension event would.
    await panel.evaluate(() =>
      chrome.runtime.sendMessage({ version: 1, type: "E2E_WAKE" }).catch(() => undefined),
    );
    await expect.poll(thread).not.toBe(before);
    // The grace period is the behaviour under test: wait it out, then the rule
    // must still be there because the panel reconnected its port.
    await panel.waitForTimeout(CAPTION_RULE_SWEEP_GRACE_MS + 1_000);
    expect(await panelRules()).toEqual(ruleIds);

    held.release();
    await expectFinished(panel, []);
    expect(services.uploads).toHaveLength(1);
    expect(services.cdn.every((hit) => hit.status === 206 && hit.referer)).toBe(true);
    await expect.poll(panelRules).toEqual([]);
  });

  test("closing the panel mid-capture removes the rule through the background", async () => {
    const { panel } = await openPanelOnPlayer();
    const held = services.holdNextCdnResponse();
    await panel.getByRole("button", { name: "음성 보내기" }).click();
    await held.arrived;
    expect(await captionRules(worker)).toHaveLength(1);
    await panel.close();
    await expect.poll(() => captionRules(worker)).toEqual([]);
    held.release();
    expect(services.uploads).toHaveLength(0);
    expect(services.cancels()).toBe(0);
  });

  test("without a session the panel asks for Google login and sends nothing", async () => {
    await worker.evaluate((key) => chrome.storage.local.remove(key), SESSION_KEY);
    const { panel } = await detectOnPlayer();
    await expect(panel.getByText(/Google 계정으로 로그인하세요/)).toBeVisible();
    await expect(panel.getByRole("button", { name: "AI 자막 생성" })).toHaveCount(0);
    expect(services.idempotencyKeys).toEqual([]);
    expect(services.cdn).toEqual([]);
  });

  test("a weekly quota refusal is shown before any media is read", async () => {
    services.refuseQuota();
    const { panel } = await openPanelOnPlayer();
    await panel.getByRole("button", { name: "음성 보내기" }).click();
    await expect(panel.getByText(/주 7회/)).toBeVisible();
    expect(services.cdn).toEqual([]);
    expect(services.uploads).toHaveLength(0);
  });
});
