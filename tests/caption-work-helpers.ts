import { act } from "react";
import { vi } from "vitest";
import { workCommand } from "../src/captions/work-client";
import type {
  CaptionWorkCommand,
  CaptionWorkReply,
  CaptionWorkState,
  QueueWork,
  SingleWork,
  WorkRuns,
} from "../src/captions/work-protocol";

const EXTENSION = "ext";
type Listener = (message: unknown, sender: chrome.runtime.MessageSender) => void;
type CommandOf<T extends CaptionWorkCommand["type"]> = Extract<CaptionWorkCommand, { type: T }>;

/**
 * The worker as a panel page meets it: it answers caption work commands with
 * its state and pushes every change to the pages that listen. Spread `runtime`
 * into the stubbed `chrome.runtime`.
 */
export function fakeWorker() {
  const listeners: Listener[] = [];
  const waiting: { type: string; resolve: (command: CaptionWorkCommand) => void }[] = [];
  const reply = (accepted: string | null = null): CaptionWorkReply => ({
    status: "success",
    state: worker.state(),
    accepted,
  });
  const byDefault = (command: CaptionWorkCommand): CaptionWorkReply => {
    if (command.type === "CAPTION_WORK_GET") return reply();
    const { single, queue } = worker;
    if (command.type === "CAPTION_WORK_START") {
      worker.revision++;
      if (command.kind === "single")
        worker.single = {
          run: command.run,
          tabId: command.tabId,
          documentId: null,
          phase: "identifying",
          jobId: null,
          key: null,
          errorCode: null,
          title: "",
          durationS: 0,
        };
      else
        worker.queue = {
          run: command.run,
          tabId: command.tabId,
          running: true,
          items: command.items.map(({ handle, title }) => ({
            handle,
            title,
            phase: "waiting",
            errorCode: null,
            jobId: null,
            key: null,
          })),
        };
      return reply();
    }
    if (command.type === "CAPTION_WORK_DISMISS") {
      if (queue?.run === command.run && !queue.running) {
        worker.queue = null;
        worker.revision++;
      }
      return reply();
    }
    if (command.kind === "single" && single?.run === command.run) {
      worker.single = null;
      worker.revision++;
      return reply(single.phase === "queued" ? single.jobId : null);
    }
    if (command.kind === "queue" && queue?.run === command.run && queue.running) {
      worker.queue = {
        ...queue,
        running: false,
        items: queue.items.map((item) =>
          item.phase === "queued" || item.phase === "failed"
            ? item
            : { ...item, phase: "cancelled" },
        ),
      };
      worker.revision++;
    }
    return reply();
  };
  const worker = {
    instance: crypto.randomUUID(),
    revision: 0,
    single: null as SingleWork | null,
    queue: null as QueueWork | null,
    /** Every caption work command the panel sent, in order. */
    commands: [] as CaptionWorkCommand[],
    /** Scripts an answer; `undefined` leaves the command to the default worker. */
    answer: undefined as
      | ((command: CaptionWorkCommand) => CaptionWorkReply | Promise<CaptionWorkReply> | undefined)
      | undefined,
    state: (): CaptionWorkState => ({
      version: 1,
      type: "CAPTION_WORK_STATE",
      instance: worker.instance,
      revision: worker.revision,
      single: worker.single,
      queue: worker.queue,
    }),
    sent: <T extends CaptionWorkCommand["type"]>(type: T) =>
      worker.commands.filter((command): command is CommandOf<T> => command.type === type),
    /** The next command of this type. Subscribe before triggering it. */
    next: <T extends CaptionWorkCommand["type"]>(type: T) =>
      new Promise<CommandOf<T>>((resolve) =>
        waiting.push({ type, resolve: resolve as (command: CaptionWorkCommand) => void }),
      ),
    /** A change of the work, pushed to every listening panel page. */
    report: async (runs: Partial<WorkRuns>) => {
      Object.assign(worker, runs);
      worker.revision++;
      const state = worker.state();
      await act(async () => [...listeners].forEach((listener) => listener(state, { id: EXTENSION })));
    },
    runtime: {
      id: EXTENSION,
      getURL: (path: string) => `chrome-extension://${EXTENSION}/${path}`,
      sendMessage: vi.fn(async (message: unknown) => {
        const command = message as CaptionWorkCommand;
        if (typeof command?.type !== "string" || !command.type.startsWith("CAPTION_WORK_"))
          return undefined;
        worker.commands.push(command);
        const index = waiting.findIndex((entry) => entry.type === command.type);
        if (index >= 0) waiting.splice(index, 1)[0]!.resolve(command);
        return (await worker.answer?.(command)) ?? byDefault(command);
      }),
      onMessage: {
        addListener: (listener: Listener) => void listeners.push(listener),
        removeListener: (listener: Listener) => {
          const index = listeners.indexOf(listener);
          if (index >= 0) listeners.splice(index, 1);
        },
      },
    },
  };
  return worker;
}
export type FakeWorker = ReturnType<typeof fakeWorker>;

/**
 * The panel page's copy of the work outlives a test. The answer of a new,
 * idle worker replaces it, as a restarted worker's would. Call before the
 * `chrome` stub is removed.
 */
export async function forgetWork(): Promise<void> {
  vi.stubGlobal("chrome", { runtime: fakeWorker().runtime });
  await workCommand({ version: 1, type: "CAPTION_WORK_GET" });
}
