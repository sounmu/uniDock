import { useEffect, useRef, useState } from "react";
import {
  playbackCommand,
  type PlaybackCommand,
  type PlaybackSnapshot,
} from "../../src/playback/bridge";
import type { Recording } from "../../src/recordings";
import { queryActive } from "../../src/transport";

type RecordingDraft = Recording & { order: number | null };

export function usePlaybackPanel() {
  const [snapshot, setSnapshot] = useState<PlaybackSnapshot | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [recordings, setRecordingDrafts] = useState<RecordingDraft[]>([]);
  const [course, setCourseValue] = useState("");
  const [deletePrompt, setDeletePrompt] = useState(false);
  const recordingGeneration = useRef(0);

  async function run(command: PlaybackCommand) {
    setPending(true);
    const result = await playbackCommand(command);
    setPending(false);
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

  useEffect(() => {
    void run({ version: 1, type: "PLAYBACK_STATUS" });
    if (typeof chrome === "undefined" || !chrome.runtime?.onMessage) return;
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
        void run({ version: 1, type: "PLAYBACK_STATUS" });
    };
    chrome.runtime.onMessage.addListener(updated);
    return () => chrome.runtime.onMessage.removeListener(updated);
  }, []);

  function setCourse(value: string) {
    recordingGeneration.current++;
    setPending(false);
    setCourseValue(value);
    setRecordingDrafts([]);
    setError("");
    if (value) void loadRecordings(value);
  }

  async function loadRecordings(selectedId = course) {
    const selectedCourse = snapshot?.courses.find(
      (item) => item.id === selectedId,
    );
    if (!selectedCourse) return;
    const current = ++recordingGeneration.current;
    setPending(true);
    const result = await queryActive({
      version: 1,
      type: "RECORDINGS_LIST",
      course: selectedCourse.name,
    });
    if (current !== recordingGeneration.current) return;
    setPending(false);
    if (result.status === "success" && "recordings" in result) {
      setRecordingDrafts(
        result.recordings.map((item) => ({ ...item, order: null })),
      );
      setError("");
    } else {
      setError("녹화 후보를 불러오지 못했습니다. LMS 탭에서 확인하세요.");
    }
  }

  function selectRecording(handle: string, selected: boolean) {
    setRecordingDrafts((items) => {
      const target = items.find((item) => item.launchHandle === handle);
      if (!target || (selected && target.order !== null)) return items;
      if (selected) {
        const next = Math.max(0, ...items.map((item) => item.order ?? 0)) + 1;
        return items.map((item) =>
          item.launchHandle === handle ? { ...item, order: next } : item,
        );
      }
      const removed = target.order;
      return items.map((item) => ({
        ...item,
        order:
          item.launchHandle === handle
            ? null
            : removed !== null && item.order !== null && item.order > removed
              ? item.order - 1
              : item.order,
      }));
    });
  }

  async function startSelected() {
    const handles = recordings
      .filter((item) => item.order !== null && item.launchHandle)
      .sort((a, b) => a.order! - b.order!)
      .map((item) => item.launchHandle);
    if (!handles.length || handles.length > 100) return false;
    const ok = await run({
      version: 1,
      type: "PLAYBACK_START",
      handles,
    });
    if (ok) setRecordingDrafts([]);
    return ok;
  }

  return {
    snapshot,
    error,
    pending,
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
