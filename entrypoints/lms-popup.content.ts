import { defineContentScript } from "wxt/utils/define-content-script";
import { startPopupAutoClose } from "../src/lms-popup";

export default defineContentScript({
  matches: ["https://lms.korea.ac.kr/*"],
  allFrames: false,
  runAt: "document_idle",
  main(ctx) {
    if (location.origin !== "https://lms.korea.ac.kr") return;
    ctx.onInvalidated(startPopupAutoClose());
  },
});
