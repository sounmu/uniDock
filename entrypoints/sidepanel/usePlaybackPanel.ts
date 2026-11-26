import { useEffect, useRef, useState } from "react";
import {
  playbackCommand,
  type PlaybackCommand,
  type PlaybackSnapshot,
} from "../../src/playback/bridge";
import type { Recording } from "../../src/recordings";
import { QueryGate } from "./query-gate";
import { coreResult, startOperation } from "./analytics";
import {
  ERROR_CODES,
  type Operation,
  type Trigger,
} from "../../src/analytics/report";
import { useRecordingPicker, type RecordingEntry } from "./useRecordingPicker";

const playbackOperations: Partial<Record<PlaybackCommand["type"], Operation>> =
  {
    PLAYBACK_START: "playback_start",
    PLAYBACK_REFRESH: "playback_refresh",
  };

// Board videos are not LMS module items, so the runtime cannot open them.
const PICKER = {
  eligible: (item: Recording) => item.source !== "board",
  limit: 100,
};

export type PlaybackEntry = RecordingEntry;

export function usePlaybackPanel(sharedGate?: QueryGate, entry?: PlaybackEntry) {
  const localGate = useRef(new QueryGate()).current;
  const gate = sharedGate ?? localGate;
  const picker = useRecordingPicker(gate, PICKER, entry);
  const { setError } = picker;
  const [snapshot, setSnapshot] = useState<PlaybackSnapshot | null>(null);
  const [foregroundCommands, setForegroundCommands] = useState(0);
  const [stopPending, setStopPending] = useState(false);
  const [startPending, setStartPending] = useState(false);
  const [deletePrompt, setDeletePrompt] = useState(false);
  const commandGeneration = useRef(0);
  const foregroundCount = useRef(0);
  const startCount = useRef(0);
  const stopCount = useRef(0);
  const statusRequest = useRef<Promise<boolean> | null>(null);
  const statusInvalidation = useRef(0);
  const mounted = useRef(true);
  const pending = foregroundCommands > 0 || picker.loading;

  async function run(
    command: PlaybackCommand,
    background = false,
    trigger: Trigger = "user",
  ) {
    const operation = playbackOperations[command.type];
    const op = operation ? startOperation(operation, trigger) : undefined;
    if (background && command.type === "PLAYBACK_STATUS") {
      return requestStatus();
    }
    const generation = ++commandGeneration.current;
    const stopping = command.type === "PLAYBACK_STOP_ALL";
    const starting = command.type === "PLAYBACK_START";
    if (stopping) {
      stopCount.current++;
      setStopPending(true);
    } else {
      if (starting) {
        startCount.current++;
        setStartPending(true);
      }
      foregroundCount.current++;
      setForegroundCommands(foregroundCount.current);
    }
    const result = await playbackCommand(command);
    if (result.status === "success") {
      op?.success();
      if (command.type === "PLAYBACK_START") coreResult("playback_started");
    } else if (result.code === "TIMEOUT") op?.timeout();
    else
      op?.failure(
        (ERROR_CODES as readonly string[]).includes(result.code)
          ? result.code
          : "PLAYBACK",
      );
    if (!mounted.current) return false;
    if (stopping) {
      stopCount.current--;
      setStopPending(stopCount.current > 0);
    } else {
      if (starting) {
        startCount.current--;
        setStartPending(startCount.current > 0);
      }
      foregroundCount.current--;
      setForegroundCommands(foregroundCount.current);
    }
    if (!mounted.current || generation !== commandGeneration.current)
      return false;
    if (result.status === "success") {
      setSnapshot(result.snapshot);
      setError("");
    } else {
      setError(
        `재생 요청 실패 (${result.code}). LMS 로그인 및 탭 상태를 확인하세요.`,
      );
    }
    return result.status === "success";
  }

  function requestStatus(invalidate = false): Promise<boolean> {
    if (invalidate) statusInvalidation.current++;
    if (statusRequest.current) return statusRequest.current;
    const invalidation = statusInvalidation.current;
    const request = runStatus(commandGeneration.current, invalidation);
    statusRequest.current = request;
    void request.finally(() => {
      if (statusRequest.current !== request) return;
      statusRequest.current = null;
      // Collapse every notification received during this read into one
      // trailing read. Never publish the now-known-stale response above.
      if (mounted.current && statusInvalidation.current !== invalidation)
        void requestStatus();
    });
    return request;
  }

  async function runStatus(generation: number, invalidation: number) {
    const result = await playbackCommand({
      version: 1,
      type: "PLAYBACK_STATUS",
    });
    if (
      !mounted.current ||
      generation !== commandGeneration.current ||
      invalidation !== statusInvalidation.current
    )
      return false;
    if (result.status === "success") setSnapshot(result.snapshot);
    return result.status === "success";
  }

  useEffect(() => {
    mounted.current = true;
    void (async () => {
      const initialGeneration = commandGeneration.current;
      await run({ version: 1, type: "PLAYBACK_STATUS" }, true);
      if (mounted.current && initialGeneration === commandGeneration.current)
        await run({ version: 1, type: "PLAYBACK_REFRESH" }, false, "auto");
    })();
    if (typeof chrome === "undefined" || !chrome.runtime?.onMessage)
      return () => {
        mounted.current = false;
        commandGeneration.current++;
      };
    const updated = (
      message: unknown,
      sender: chrome.runtime.MessageSender,
    ) => {
      if (
        sender.id === chrome.runtime.id &&
        (sender.url === undefined ||
          sender.url === chrome.runtime.getURL("background.js")) &&
        message !== null &&
        typeof message === "object" &&
        "version" in message &&
        message.version === 1 &&
        "type" in message &&
        message.type === "PLAYBACK_UPDATED"
      )
        void requestStatus(true);
    };
    chrome.runtime.onMessage.addListener(updated);
    return () => {
      mounted.current = false;
      commandGeneration.current++;
      chrome.runtime.onMessage.removeListener(updated);
    };
  }, []);

  async function startSelected() {
    const selection = picker.takeSelection();
    if (!selection) return false;
    return run({
      version: 1,
      type: "PLAYBACK_START",
      handles: selection.handles,
      sourceTabId: selection.target.id,
      documentToken: selection.documentToken,
    });
  }

  return {
    snapshot,
    error: picker.error,
    pending,
    stopPending,
    startPending,
    recordings: picker.recordings,
    courses: picker.courses,
    course: picker.course,
    setCourse: picker.setCourse,
    deletePrompt,
    setDeletePrompt,
    run,
    loadRecordings: picker.loadRecordings,
    loadCourses: picker.loadCourses,
    selectRecording: picker.selectRecording,
    startSelected,
  };
}

export type PlaybackModel = ReturnType<typeof usePlaybackPanel>;
