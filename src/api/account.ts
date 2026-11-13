import { readJsonBounded } from "./body";
import { readUrl } from "../security/policy";
import { object } from "../playback/bridge";
import { internalId } from "../recordings";

export async function currentAccount(
  origin: string,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const controller = new AbortController();
  // Two identity checks wrap a list miss. Keep their combined budget below
  // the 23s panel deadline while listQuery retains its own 20s bound.
  const timer = setTimeout(() => controller.abort(), 1000);
  try {
    const response = await fetcher(
      readUrl("/api/v1/users/self", origin, "/api/v1/users/self").href,
      {
        method: "GET",
        credentials: "same-origin",
        redirect: "manual",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      },
    );
    if (
      response.type === "opaqueredirect" ||
      response.status === 401 ||
      (response.status >= 300 && response.status < 400) ||
      response.headers.get("content-type")?.includes("text/html")
    )
      throw new Error("LOGIN_REQUIRED");
    if (response.status === 403) throw new Error("FORBIDDEN");
    if (!response.ok) throw new Error("NETWORK");
    if (
      !/^application\/json\b/i.test(response.headers.get("content-type") ?? "")
    )
      throw new Error("INVALID_RESPONSE");
    const value = await readJsonBounded(response);
    const id = object(value) ? internalId(value.id) : undefined;
    if (!id) throw new Error("LOGIN_REQUIRED");
    return id;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
