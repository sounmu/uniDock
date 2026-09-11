import { defineContentScript } from 'wxt/utils/define-content-script';
import { listCourses, listQuery } from '../src/api/client';
import { isRequest, type Result } from '../src/protocol';
import { allowedPage, LMS_MATCHES } from '../src/security/policy';
export default defineContentScript({
  matches: LMS_MATCHES, runAt: 'document_idle', allFrames: false,
  main() {
    let pending: { key: string; result: Promise<Result> } | undefined;
    chrome.runtime.onMessage.addListener((message: unknown, sender, respond) => {
      if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('sidepanel.html') || !isRequest(message) || !allowedPage(location.href)) return false;
      const key = JSON.stringify(message);
      if (pending && pending.key !== key) {
        respond({ status: 'error', code: 'BUSY' });
        return false;
      }
      pending ??= { key, result: (message.type === 'COURSES_LIST' ? listCourses(location.origin) : listQuery(location.origin, message)).finally(() => { pending = undefined; }) };
      void pending.result.then(respond);
      return true;
    });
  },
});
