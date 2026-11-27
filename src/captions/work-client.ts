import { backgroundSender } from "../playback/bridge";
import {
  captionWorkReply,
  isCaptionWorkState,
  type CaptionWorkCommand,
  type CaptionWorkReply,
  type CaptionWorkState,
} from "./work-protocol";

const UNKNOWN: CaptionWorkState = {
  version: 1,
  type: "CAPTION_WORK_STATE",
  instance: "",
  revision: 0,
  single: null,
  queue: null,
};

let state = UNKNOWN;
let listening = false;
const listeners = new Set<() => void>();

function accept(next: CaptionWorkState): void {
  if (next.instance === state.instance && next.revision <= state.revision) return;
  state = next;
  for (const listener of [...listeners]) listener();
}

const receive = (message: unknown, sender: chrome.runtime.MessageSender) => {
  if (isCaptionWorkState(message) && backgroundSender(sender)) accept(message);
};

/** Caption preparation as the worker last reported it to this panel page. */
export function workState(): CaptionWorkState {
  return state;
}

/** Sends a command and takes the state in its answer; a failure is an error reply. */
export async function workCommand(command: CaptionWorkCommand): Promise<CaptionWorkReply> {
  try {
    const reply = captionWorkReply(await chrome.runtime.sendMessage(command));
    if (!reply) return { status: "error", code: "UNKNOWN" };
    if (reply.status === "success") accept(reply.state);
    return reply;
  } catch {
    return { status: "error", code: "UNKNOWN" };
  }
}

/**
 * Panel page side: the worker pushes every change while a page listens, and a
 * page that starts listening asks once, so a reopened panel shows work that
 * went on without it.
 */
export function subscribeWork(listener: () => void): () => void {
  if (!listening && typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
    listening = true;
    chrome.runtime.onMessage.addListener(receive);
    void workCommand({ version: 1, type: "CAPTION_WORK_GET" });
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size || !listening) return;
    listening = false;
    chrome.runtime.onMessage.removeListener(receive);
  };
}
