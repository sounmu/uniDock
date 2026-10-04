import {
  PostHogCoreStateless,
  type PostHogFetchOptions,
  type PostHogFetchResponse,
  type PostHogPersistedProperty,
} from "@posthog/core";
import { ANALYTICS_HOST, type AnalyticsEvent } from "./contract";

/** DOM-free SDK adapter: no autocapture, replay, flags, surveys or remote config. */
export class AnalyticsSink extends PostHogCoreStateless {
  private readonly memory = new Map<PostHogPersistedProperty, unknown>();
  private readonly requests = new Set<AbortController>();
  private stopped = false;
  constructor(key: string) {
    super(key, {
      host: ANALYTICS_HOST,
      disableGeoip: true,
      disableCompression: true,
      preloadFeatureFlags: false,
      disableRemoteFeatureFlags: true,
      disableSurveys: true,
      personProfiles: "never",
      flushInterval: 0,
      fetchRetryCount: 0,
      requestTimeout: 5000,
    });
  }
  getLibraryId() {
    return "unidock";
  }
  getLibraryVersion() {
    return "1";
  }
  getCustomUserAgent() {
    return undefined;
  }
  getPersistedProperty<T>(key: PostHogPersistedProperty): T | undefined {
    return this.memory.get(key) as T | undefined;
  }
  setPersistedProperty<T>(key: PostHogPersistedProperty, value: T | null) {
    if (value === null) this.memory.delete(key);
    else this.memory.set(key, value);
  }
  async fetch(
    url: string,
    options: PostHogFetchOptions,
  ): Promise<PostHogFetchResponse> {
    // Defense against future SDK additions: only batch ingestion may use the network.
    if (
      this.stopped ||
      url !== `${ANALYTICS_HOST}/batch/` ||
      options.method !== "POST" ||
      typeof options.body !== "string" ||
      options.body.length > 8192
    )
      throw new Error("ANALYTICS_BLOCKED");
    const controller = new AbortController();
    this.requests.add(controller);
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    try {
      const response = await globalThis.fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: options.body,
        signal: controller.signal,
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        referrerPolicy: "no-referrer",
      });
      // Ingestion acknowledgements are not configuration; never read/log their body.
      await response.body?.cancel();
      return {
        status: response.status,
        text: async () => "",
        json: async () => ({}),
      };
    } finally {
      options.signal?.removeEventListener("abort", abort);
      this.requests.delete(controller);
    }
  }
  async send(id: string, version: string, data: AnalyticsEvent): Promise<void> {
    if (this.stopped) return;
    const { event, ...properties } = data;
    await this.captureStatelessImmediate(id, event, {
      ...properties,
      extension_version: version,
      $process_person_profile: false,
      $geoip_disable: true,
      $ip: null,
    });
  }
  stop() {
    this.stopped = true;
    for (const request of this.requests) request.abort();
    this.memory.clear();
  }
}
