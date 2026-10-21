import { defineContentScript } from "wxt/utils/define-content-script";
import { startPopupAutoClose } from "../src/lms-popup";
import { POPUP_ORIGIN } from "../src/popup-settings";

export default defineContentScript({
  matches: ["https://lms.korea.ac.kr/*"],
  allFrames: false,
  runAt: "document_idle",
  main(ctx) {
    if (location.origin !== POPUP_ORIGIN) return;
    ctx.onInvalidated(startPopupAutoClose());
  },
});
