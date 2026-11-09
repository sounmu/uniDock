import { useEffect, useRef, useState } from "react";
import { isRequest, type Request, type Result } from "../../src/protocol";
import { queryActive, type QueryTarget } from "../../src/transport";
import { usePanelNavigation } from "./usePanelNavigation";
import { useDocumentDownloads } from "./useDocumentDownloads";
import { messages } from "./query-messages";
import { QueryGate } from "./query-gate";
import { coreResult, startOperation } from "./analytics";
import type { CoreResult, Operation } from "../../src/analytics/report";

const queryOperations: Partial<
  Record<Request["type"], [Operation, CoreResult | null]>
> = {
  COURSES_LIST: ["courses_load", null],
  ASSIGNMENTS_LIST: ["course_items_load", "course_items_shown"],
  DEADLINES_LIST: ["course_items_load", "course_items_shown"],
  RECORDINGS_LIST: ["course_items_load", "course_items_shown"],
  DOCUMENTS_LIST: ["course_items_load", "course_items_shown"],
  TODO_LIST: ["tasks_load", "tasks_shown"],
  UPCOMING_LIST: ["tasks_load", "tasks_shown"],
};

type CourseSnapshot = Extract<
  Result,
  | { assignments: unknown }
  | { deadlines: unknown }
  | { recordings: unknown }
  | { documents: unknown }
>;
function isCourseSnapshot(
  result: Extract<Result, { status: "success" }>,
): result is CourseSnapshot {
  return (
    "assignments" in result ||
    "deadlines" in result ||
    "recordings" in result ||
    "documents" in result
  );
}

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
  // One course list query (assignments, recordings or materials from the same
  // course-list source) keeps its rows while a refresh is pending and its last
  // successful time across transient failures.
  const [courseRefresh, setCourseRefresh] = useState<{
    key: string;
    updatedAt?: number;
    result?: CourseSnapshot;
  } | null>(null);
  function courseKey(query: Request): string | null {
    return query.type === "ASSIGNMENTS_LIST" ||
      query.type === "DEADLINES_LIST" ||
      query.type === "RECORDINGS_LIST" ||
      query.type === "DOCUMENTS_LIST"
      ? JSON.stringify([
          query.type,
          "courseSelector" in query ? query.courseSelector : query.course,
          courseTarget.current,
        ])
      : null;
  }
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
    // `used` holds every consumed one-use handle; `opened` only successes.
    used: new Set<string>(),
    opened: new Set<string>(),
    notice: "",
  });
  function resetRecordingAction() {
    recordingTarget.current = null;
    setRecordingAction({
      pending: false,
      used: new Set(),
      opened: new Set(),
      notice: "",
    });
  }
  function clear() {
    generation.current++;
    downloads.cancel();
    resetRecordingAction();
    setCourseRefresh(null);
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
    const [operation, shown] = queryOperations[query.type] ?? [null, null];
    const op = operation ? startOperation(operation) : undefined;
    if (
      "courseSelector" in query &&
      query.courseSelector &&
      !courseTarget.current
    ) {
      generation.current++;
      setCourseRefresh(null);
      setState({ status: "error", code: "STALE_SELECTION" });
      op?.failure("STALE_SELECTION");
      return;
    }
    const current = ++generation.current;
    const key = courseKey(query);
    if (query.type === "COURSES_LIST") courseTarget.current = null;
    downloads.cancel();
    if (query.type === "DOCUMENTS_LIST") downloads.reset();
    resetRecordingAction();
    setCourseRefresh((previous) =>
      key !== null && previous?.key === key ? previous : null,
    );
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
      if (key !== null) {
        if (result.status === "success" && isCourseSnapshot(result)) {
          setCourseRefresh({ key, updatedAt: Date.now(), result });
        } else {
          // A failed response never restores rows, selectors, or the LMS cache.
          setCourseRefresh((previous) =>
            previous?.key === key &&
            result.status === "error" &&
            ["NETWORK", "TIMEOUT", "RATE_LIMITED", "BUSY"].includes(result.code)
              ? { key, updatedAt: previous.updatedAt }
              : null,
          );
        }
      }
      setState(result);
      // A superseded load has no final outcome: it was abandoned, not failed.
      op?.result(result);
      if (shown && result.status === "success") coreResult(shown);
    }
  }
  async function openSelection(
    type: "RECORDING_OPEN" | "DOCUMENT_OPEN",
    handle: string,
  ) {
    if (opening.current || recordingAction.used.has(handle)) return;
    const op = startOperation(
      type === "RECORDING_OPEN" ? "recording_open" : "document_open",
    );
    const target = recordingTarget.current;
    if (!target) {
      op.failure("RELOAD_TAB");
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
    op.result(result);
    if (result.status === "success")
      coreResult(
        type === "RECORDING_OPEN" ? "recording_opened" : "document_opened",
      );
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
      opened:
        result.status === "success"
          ? new Set([...previous.opened, handle])
          : previous.opened,
      notice:
        result.status === "success"
          ? type === "DOCUMENT_OPEN"
            ? "새 LMS 자료 탭을 열었습니다."
            : "새 탭을 열었습니다."
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
  const snapshot =
    courseRefresh?.key === courseKey(query) ? courseRefresh : null;
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
    ...(snapshot?.updatedAt !== undefined
      ? { updatedAt: snapshot.updatedAt }
      : {}),
    // Rows retained for display only while the same query is pending; their
    // one-use handles stay unusable until the fresh list replaces them.
    ...(state.status === "loading" && snapshot?.result
      ? { pendingResult: snapshot.result }
      : {}),
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
