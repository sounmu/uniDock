import { useEffect, useRef, useState } from "react";
import { isRequest, type Request, type Result } from "../../src/protocol";
import { queryActive, type QueryTarget } from "../../src/transport";
import { usePanelNavigation } from "./usePanelNavigation";
import { useDocumentDownloads } from "./useDocumentDownloads";
import { messages } from "./query-messages";
import { QueryGate } from "./query-gate";
import { featureResult } from "./analytics";
import type { AnalyticsFeature } from "../../src/analytics/contract";

const queryFeatures: Partial<Record<Request["type"], AnalyticsFeature>> = {
  COURSES_LIST: "courses",
  ASSIGNMENTS_LIST: "assignments",
  DEADLINES_LIST: "assignments",
  TODO_LIST: "tasks",
  UPCOMING_LIST: "tasks",
  RECORDINGS_LIST: "recordings",
  DOCUMENTS_LIST: "documents",
};

export function useSidepanelQuery(sharedGate?: QueryGate) {
  const localGate = useRef(new QueryGate()).current;
  const gate = sharedGate ?? localGate;
  const {
    section,
    tasksMode,
    courseTab,
    course,
    selectedCourse,
    setCourse,
    view,
    setView,
  } = usePanelNavigation();
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [state, setState] = useState<Result | { status: "idle" | "loading" }>({
    status: "idle",
  });
  const generation = useRef(0);
  const capabilityScope = useRef(crypto.randomUUID()).current;
  const courseScope = useRef(crypto.randomUUID()).current;
  const inFlight = useRef<Promise<Result> | null>(null);
  const recordingTarget = useRef<QueryTarget | null>(null);
  const courseTarget = useRef<QueryTarget | null>(null);
  const downloads = useDocumentDownloads({
    gate,
    generation,
    inFlight,
    target: recordingTarget,
    course,
  });
  const opening = useRef(false);
  const [recordingAction, setRecordingAction] = useState({
    pending: false,
    used: new Set<string>(),
    notice: "",
  });
  function resetRecordingAction() {
    recordingTarget.current = null;
    setRecordingAction({ pending: false, used: new Set(), notice: "" });
  }
  function clear() {
    generation.current++;
    downloads.cancel();
    resetRecordingAction();
    setState({ status: "idle" });
  }
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  function showCourses() {
    downloads.cancel();
    resetRecordingAction();
    setCourse(null);
    setView("COURSES_LIST");
    void load({ version: 1, type: "COURSES_LIST" });
  }
  async function load(query: Request, options: { refresh?: boolean } = {}) {
    if (!isRequest(query)) {
      clear();
      return;
    }
    const feature = queryFeatures[query.type];
    const report = feature ? featureResult(feature) : undefined;
    if (
      "courseSelector" in query &&
      query.courseSelector &&
      !courseTarget.current
    ) {
      generation.current++;
      setState({ status: "error", code: "STALE_SELECTION" });
      return;
    }
    const current = ++generation.current;
    if (query.type === "COURSES_LIST") courseTarget.current = null;
    downloads.cancel();
    if (query.type === "DOCUMENTS_LIST") downloads.reset();
    resetRecordingAction();
    setState({ status: "loading" });
    // Finish the active LMS request, then execute only the latest selected view.
    const lease = await gate.acquire();
    if (current !== generation.current) {
      lease.release();
      return;
    }
    let issuingCourseTarget: QueryTarget | null = null;
    const work =
      query.type === "COURSES_LIST"
        ? queryActive(query, {
            refresh: options.refresh,
            capabilityScope: courseScope,
            onTarget: (target) => (issuingCourseTarget = target),
          })
        : query.type === "RECORDINGS_LIST" || query.type === "DOCUMENTS_LIST"
          ? queryActive(query, {
              refresh: options.refresh,
              capabilityScope,
              ...(courseTarget.current ? { target: courseTarget.current } : {}),
              onTarget: (target) => {
                if (current === generation.current)
                  recordingTarget.current = target;
              },
            })
          : queryActive(query, {
              refresh: options.refresh,
              ...(query.type === "ASSIGNMENTS_LIST" ||
              query.type === "DEADLINES_LIST"
                ? courseTarget.current
                  ? { target: courseTarget.current }
                  : {}
                : {}),
            });
    inFlight.current = work;
    const result = await work.finally(lease.release);
    if (inFlight.current === work) inFlight.current = null;
    if (current === generation.current) {
      if (query.type === "COURSES_LIST") {
        courseTarget.current =
          result.status === "success" && "courses" in result
            ? issuingCourseTarget
            : null;
      } else if (
        "courseSelector" in query &&
        result.status === "error" &&
        (result.code === "STALE_SELECTION" || result.code === "RELOAD_TAB")
      ) {
        // Selectors are scoped to the exact course-list source document.
        // Never retry them against another document or fall back to a name.
        courseTarget.current = null;
        setCourse(null);
      }
      setState(result);
      report?.(result.status === "success");
    }
  }
  async function openSelection(
    type: "RECORDING_OPEN" | "DOCUMENT_OPEN",
    handle: string,
  ) {
    const report = featureResult(
      type === "RECORDING_OPEN" ? "recording_open" : "document_open",
    );
    if (opening.current || recordingAction.used.has(handle)) return;
    const target = recordingTarget.current;
    if (!target) {
      setRecordingAction((previous) => ({
        ...previous,
        notice: messages.RELOAD_TAB,
      }));
      return;
    }
    const current = generation.current;
    opening.current = true;
    setRecordingAction((previous) => ({
      ...previous,
      pending: true,
      notice: "",
    }));
    const lease = await gate.acquire();
    if (current !== generation.current) {
      lease.release();
      opening.current = false;
      return;
    }
    const work = queryActive({ version: 1, type, handle }, { target });
    inFlight.current = work;
    const result = await work.finally(lease.release);
    if (inFlight.current === work) inFlight.current = null;
    opening.current = false;
    if (current !== generation.current) return;
    report(result.status === "success");
    setRecordingAction((previous) => ({
      pending: false,
      used:
        result.status === "success" ||
        (result.status === "error" &&
          ["STALE_SELECTION", "TAB_OPEN_FAILED", "TIMEOUT"].includes(
            result.code,
          ))
          ? new Set([...previous.used, handle])
          : previous.used,
      notice:
        result.status === "success"
          ? type === "DOCUMENT_OPEN"
            ? "새 LMS 자료 탭을 열었습니다."
            : "새 LMS/LTI 탭을 열었습니다."
          : messages[result.code],
    }));
  }
  const openRecording = (handle: string) =>
    openSelection("RECORDING_OPEN", handle);
  const openDocument = (handle: string) =>
    openSelection("DOCUMENT_OPEN", handle);
  const needsCourse =
    view === "ASSIGNMENTS_LIST" ||
    view === "RECORDINGS_LIST" ||
    view === "DOCUMENTS_LIST";
  const query: Request = needsCourse
    ? selectedCourse
      ? {
          version: 1,
          type: view,
          courseSelector: selectedCourse.courseSelector,
        }
      : { version: 1, type: view, courseSelector: "" }
    : view === "UPCOMING_LIST"
      ? {
          version: 1,
          type: view,
          ...(start ? { start_date: start } : {}),
          ...(end ? { end_date: end } : {}),
        }
      : {
          version: 1,
          type:
            view === "CAPTIONS" || view === "PLAYBACK" ? "COURSES_LIST" : view,
        };
  return {
    section,
    tasksMode,
    courseTab,
    downloads,
    view,
    setView,
    course,
    selectedCourse,
    setCourse,
    start,
    setStart,
    end,
    setEnd,
    state,
    recordingAction,
    clear,
    showCourses,
    load,
    openRecording,
    openDocument,
    needsCourse,
    query,
    isQueryValid: isRequest(query),
  };
}
