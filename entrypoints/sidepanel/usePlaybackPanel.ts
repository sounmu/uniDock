import { useEffect, useRef, useState } from "react";
import {
  playbackCommand,
  type PlaybackCommand,
  type PlaybackSnapshot,
} from "../../src/playback/bridge";
import type { Recording } from "../../src/recordings";
import { queryActive, type QueryTarget } from "../../src/transport";
import { QueryGate } from "./query-gate";

type RecordingDraft = Recording & { order: number | null };
type RecordingSelection = {
  generation: number;
  recordings: RecordingDraft[];
  target: QueryTarget | null;
};

export function usePlaybackPanel(sharedGate?: QueryGate) {
  const localGate = useRef(new QueryGate()).current;
  const gate = sharedGate ?? localGate;
  const [snapshot, setSnapshot] = useState<PlaybackSnapshot | null>(null);
  const [error, setError] = useState("");
  const [foregroundCommands, setForegroundCommands] = useState(0);
  const [recordingLoad, setRecordingLoad] = useState(false);
  const [stopPending, setStopPending] = useState(false);
  const [startPending, setStartPending] = useState(false);
  const [recordings, setRecordingDrafts] = useState<RecordingDraft[]>([]);
  const [course, setCourseValue] = useState("");
  const [deletePrompt, setDeletePrompt] = useState(false);
  const recordingGeneration = useRef(0);
  const recordingSelection = useRef<RecordingSelection | null>(null);
  const commandGeneration = useRef(0);
  const foregroundCount = useRef(0);
  const startCount = useRef(0);
  const stopCount = useRef(0);
  const statusRequest = useRef<Promise<boolean> | null>(null);
  const mounted = useRef(true);
  const pending = foregroundCommands > 0 || recordingLoad;

  async function run(command: PlaybackCommand, background = false) {
    if (background && command.type === "PLAYBACK_STATUS") {
      if (statusRequest.current) return statusRequest.current;
      const request = runStatus(commandGeneration.current);
      statusRequest.current = request;
      void request.finally(() => {
        if (statusRequest.current === request) statusRequest.current = null;
      });
      return request;
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

  async function runStatus(generation: number) {
    const result = await playbackCommand({
      version: 1,
      type: "PLAYBACK_STATUS",
    });
    if (!mounted.current || generation !== commandGeneration.current)
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
        await run({ version: 1, type: "PLAYBACK_REFRESH" });
    })();
    if (typeof chrome === "undefined" || !chrome.runtime?.onMessage)
      return () => {
        mounted.current = false;
        commandGeneration.current++;
        recordingGeneration.current++;
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
        void run({ version: 1, type: "PLAYBACK_STATUS" }, true);
    };
    chrome.runtime.onMessage.addListener(updated);
    return () => {
      mounted.current = false;
      commandGeneration.current++;
      recordingGeneration.current++;
      chrome.runtime.onMessage.removeListener(updated);
    };
  }, []);

  function setCourse(value: string) {
    recordingGeneration.current++;
    setRecordingLoad(false);
    setCourseValue(value);
    setRecordingDrafts([]);
    recordingSelection.current = null;
    setError("");
    if (value) void loadRecordings(value);
  }

  async function loadRecordings(selectedId = course) {
    const current = ++recordingGeneration.current;
    recordingSelection.current = null;
    setRecordingDrafts([]);
    const selectedCourse = snapshot?.courses.find(
      (item) => item.id === selectedId,
    );
    if (!selectedCourse) {
      setRecordingLoad(false);
      return;
    }
    setRecordingLoad(true);
    const lease = await gate.acquire();
    if (!mounted.current || current !== recordingGeneration.current) {
      lease.release();
      return;
    }
    let target: QueryTarget | null = null;
    const result = await queryActive(
      {
        version: 1,
        type: "RECORDINGS_LIST",
        course: selectedCourse.name,
      },
      { refresh: true, onTarget: (accepted) => (target = accepted) },
    ).finally(lease.release);
    if (!mounted.current || current !== recordingGeneration.current) return;
    setRecordingLoad(false);
    if (result.status === "success" && "recordings" in result) {
      const drafts = result.recordings.map((item) => ({
        ...item,
        order: null,
      }));
      recordingSelection.current = {
        generation: current,
        recordings: drafts,
        target,
      };
      setRecordingDrafts(drafts);
      setError("");
    } else {
      setError("녹화 후보를 불러오지 못했습니다. LMS 탭에서 확인하세요.");
    }
  }

  function selectRecording(handle: string, selected: boolean) {
    const draft = recordingSelection.current;
    if (!draft) return;
    const target = draft.recordings.find(
      (item) => item.launchHandle === handle,
    );
    if (!target || (selected && target.order !== null)) return;
    const removed = target.order;
    const updated = selected
      ? draft.recordings.map((item) =>
          item.launchHandle === handle
            ? {
                ...item,
                order:
                  Math.max(
                    0,
                    ...draft.recordings.map((entry) => entry.order ?? 0),
                  ) + 1,
              }
            : item,
        )
      : draft.recordings.map((item) => ({
          ...item,
          order:
            item.launchHandle === handle
              ? null
              : removed !== null && item.order !== null && item.order > removed
                ? item.order - 1
                : item.order,
        }));
    recordingSelection.current = { ...draft, recordings: updated };
    setRecordingDrafts(updated);
  }

  async function startSelected() {
    const draft = recordingSelection.current;
    if (!draft) return false;
    const handles = draft.recordings
      .filter((item) => item.order !== null && item.launchHandle)
      .sort((a, b) => a.order! - b.order!)
      .map((item) => item.launchHandle);
    const target = draft.target;
    if (!handles.length || handles.length > 100 || !target?.documentToken)
      return false;
    // Handles are one-use capabilities. Revoke this exact draft before the
    // command can yield so duplicate clicks and failed/timed-out starts cannot
    // submit it again. A later list owns a different generation and is never
    // cleared by this command's completion.
    if (recordingSelection.current?.generation !== draft.generation)
      return false;
    recordingGeneration.current++;
    recordingSelection.current = null;
    setRecordingDrafts([]);
    return run({
      version: 1,
      type: "PLAYBACK_START",
      handles,
      sourceTabId: target.id,
      documentToken: target.documentToken,
    });
  }

  return {
    snapshot,
    error,
    pending,
    stopPending,
    startPending,
    recordings,
    course,
    setCourse,
    deletePrompt,
    setDeletePrompt,
    run,
    loadRecordings,
    selectRecording,
    startSelected,
  };
}

export type PlaybackModel = ReturnType<typeof usePlaybackPanel>;
