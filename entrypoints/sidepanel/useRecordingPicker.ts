import { useEffect, useRef, useState } from "react";
import type { Recording } from "../../src/recordings";
import type { Course } from "../../src/domain";
import { queryActive, type QueryTarget } from "../../src/transport";
import type { QueryGate } from "./query-gate";

export type RecordingDraft = Recording & { order: number | null };
type RecordingSelection = {
  generation: number;
  recordings: RecordingDraft[];
  target: QueryTarget | null;
};

export interface RecordingEntry {
  readonly course: Course;
  readonly recordings: readonly Recording[];
  readonly target: QueryTarget;
  readonly selectedHandles: readonly string[];
}

export interface RecordingPickerOptions {
  readonly eligible: (item: Recording) => boolean;
  /** Most recordings an entry may preselect and a selection may hold. */
  readonly limit: number;
}

export function useRecordingPicker(
  gate: QueryGate,
  { eligible, limit }: RecordingPickerOptions,
  entry?: RecordingEntry,
) {
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [recordings, setRecordingDrafts] = useState<RecordingDraft[]>([]);
  const [courses, setCourses] = useState<Course[]>([]);
  const [course, setCourseValue] = useState("");
  const recordingGeneration = useRef(0);
  const capabilityScope = useRef(crypto.randomUUID()).current;
  const courseScope = useRef(crypto.randomUUID()).current;
  const courseTarget = useRef<QueryTarget | null>(null);
  const courseLoadInFlight = useRef(false);
  const recordingSelection = useRef<RecordingSelection | null>(null);
  const mounted = useRef(true);
  const acceptedEntry = useRef<RecordingEntry | undefined>(undefined);
  const importedCourseList = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      recordingGeneration.current++;
    };
  }, []);

  useEffect(() => {
    if (!entry || acceptedEntry.current === entry) return;
    acceptedEntry.current = entry;
    const generation = ++recordingGeneration.current;
    const selected = [...new Set(entry.selectedHandles)].filter((handle) =>
      entry.recordings.some(
        (item) => item.launchHandle === handle && eligible(item),
      ),
    ).slice(0, limit);
    const drafts = entry.recordings.map((item) => {
      const index = item.launchHandle && eligible(item)
        ? selected.indexOf(item.launchHandle)
        : -1;
      return { ...item, order: index < 0 ? null : index + 1 };
    });
    recordingSelection.current = {
      generation,
      recordings: drafts,
      target: entry.target,
    };
    courseTarget.current = entry.target;
    importedCourseList.current = true;
    setCourses([entry.course]);
    setCourseValue(entry.course.courseSelector);
    setRecordingDrafts(drafts);
    setLoading(false);
    setError("");
  }, [entry, eligible, limit]);

  function setCourse(value: string) {
    recordingGeneration.current++;
    setLoading(false);
    setCourseValue(value);
    setRecordingDrafts([]);
    recordingSelection.current = null;
    setError("");
    if (value) void loadRecordings(value);
  }

  async function loadCourses() {
    if (
      courseLoadInFlight.current ||
      (!importedCourseList.current && courses.length && courseTarget.current)
    )
      return;
    courseLoadInFlight.current = true;
    importedCourseList.current = false;
    courseTarget.current = null;
    const current = ++recordingGeneration.current;
    setCourseValue("");
    setCourses([]);
    setRecordingDrafts([]);
    recordingSelection.current = null;
    setLoading(true);
    const lease = await gate.acquire();
    if (!mounted.current || current !== recordingGeneration.current) {
      lease.release();
      courseLoadInFlight.current = false;
      return;
    }
    let target: QueryTarget | null = null;
    const result = await queryActive(
      { version: 1, type: "COURSES_LIST" },
      {
        capabilityScope: courseScope,
        onTarget: (accepted) => (target = accepted),
      },
    ).finally(lease.release);
    courseLoadInFlight.current = false;
    if (!mounted.current || current !== recordingGeneration.current) return;
    setLoading(false);
    if (result.status === "success" && "courses" in result && target) {
      courseTarget.current = target;
      setCourses(result.courses);
      setError("");
    } else {
      courseTarget.current = null;
      setError("과목 목록을 불러오지 못했습니다. LMS 탭에서 확인하세요.");
    }
  }

  async function loadRecordings(selectedId = course) {
    const current = ++recordingGeneration.current;
    recordingSelection.current = null;
    setRecordingDrafts([]);
    const selectedCourse = courses.find(
      (item) => item.courseSelector === selectedId,
    );
    if (!selectedCourse || !courseTarget.current) {
      setLoading(false);
      setError("과목 목록을 다시 불러온 뒤 과목을 다시 선택하세요.");
      return;
    }
    setLoading(true);
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
        courseSelector: selectedCourse.courseSelector,
      },
      {
        refresh: true,
        capabilityScope,
        target: courseTarget.current,
        onTarget: (accepted) => (target = accepted),
      },
    ).finally(lease.release);
    if (!mounted.current || current !== recordingGeneration.current) return;
    setLoading(false);
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
      if (
        result.status === "error" &&
        (result.code === "STALE_SELECTION" || result.code === "RELOAD_TAB")
      ) {
        courseTarget.current = null;
        setCourseValue("");
        setCourses([]);
      }
      setError(
        result.status === "error" &&
          (result.code === "STALE_SELECTION" || result.code === "RELOAD_TAB")
          ? "과목 목록을 다시 불러온 뒤 과목을 다시 선택하세요."
          : "녹화 후보를 불러오지 못했습니다. LMS 탭에서 확인하세요.",
      );
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

  /** The selected handles in order and the tab that issued them. Handles are
      one-use capabilities, so the draft is revoked before the caller can yield:
      a duplicate click or a failed run cannot submit it again. */
  function takeSelection(): {
    handles: string[];
    target: QueryTarget;
    documentToken: string;
  } | null {
    const draft = recordingSelection.current;
    if (!draft) return null;
    const handles = draft.recordings
      .filter((item) => item.order !== null && item.launchHandle)
      .sort((a, b) => a.order! - b.order!)
      .map((item) => item.launchHandle);
    const target = draft.target;
    if (!handles.length || handles.length > limit || !target?.documentToken)
      return null;
    recordingGeneration.current++;
    recordingSelection.current = null;
    setRecordingDrafts([]);
    return { handles, target, documentToken: target.documentToken };
  }

  return {
    error,
    setError,
    loading,
    recordings,
    courses,
    course,
    setCourse,
    loadCourses,
    loadRecordings,
    selectRecording,
    takeSelection,
  };
}
