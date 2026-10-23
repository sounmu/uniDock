import { defineContentScript } from "wxt/utils/define-content-script";
import { startPopupAutoClose } from "../src/lms-popup";
import { POPUP_ORIGIN } from "../src/popup-settings";

// Not in the manifest: the worker registers it for `lms.korea.ac.kr` only
// after the user opts in and grants the optional host permission.
export default defineContentScript({
  registration: "runtime",
  main(ctx) {
    if (location.origin !== POPUP_ORIGIN || window !== window.top) return;
    ctx.onInvalidated(startPopupAutoClose());
  },
});
