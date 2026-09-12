import { NavigationCatalog } from "../src/navigation-catalog";
import { defineContentScript } from "wxt/utils/define-content-script";
import { listCourses, listQuery } from "../src/api/client";
import { isRequest, parseResult, type Result } from "../src/protocol";
import { allowedPage, LMS_MATCHES } from "../src/security/policy";
export default defineContentScript({
  matches: LMS_MATCHES,
  runAt: "document_idle",
  allFrames: false,
  main() {
    const catalog = new NavigationCatalog();
    async function open(handle: string): Promise<Result> {
      const url = catalog.take(handle, location.origin);
      if (!url) return { status: "error", code: "STALE_SELECTION" };
      try {
        const result: unknown = await chrome.runtime.sendMessage({
          version: 1,
          type: "OPEN_LMS_TARGET",
          url,
        });
        return parseResult(result, {
          version: 1,
          type: "RECORDING_OPEN",
          handle,
        });
      } catch {
        return { status: "error", code: "TAB_OPEN_FAILED" };
      }
    }
    let pending: { key: string; result: Promise<Result> } | undefined;
    chrome.runtime.onMessage.addListener(
      (message: unknown, sender, respond) => {
        if (
          sender.id !== chrome.runtime.id ||
          sender.url !== chrome.runtime.getURL("sidepanel.html") ||
          !isRequest(message) ||
          !allowedPage(location.href)
        )
          return false;
        const key = JSON.stringify(message);
        if (pending && pending.key !== key) {
          respond({ status: "error", code: "BUSY" });
          return false;
        }
        if (!pending) {
          if (message.type !== "RECORDING_OPEN") catalog.clear();
          const result =
            message.type === "RECORDING_OPEN"
              ? open(message.handle)
              : message.type === "COURSES_LIST"
                ? listCourses(location.origin)
                : message.type === "RECORDINGS_LIST"
                  ? listQuery(
                      location.origin,
                      message,
                      fetch,
                      Date.now(),
                      catalog,
                    )
                  : listQuery(location.origin, message);
          pending = {
            key,
            result: result.finally(() => {
              pending = undefined;
            }),
          };
        }
        void pending.result.then(respond);
        return true;
      },
    );
  },
});
