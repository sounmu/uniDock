import { useEffect, useRef, useState } from "react";
import {
  isRequest,
  type ErrorCode,
  type Request,
  type Result,
} from "../../src/protocol";
import { queryActive, type QueryTarget } from "../../src/transport";

export type SidepanelView =
  | "COURSES_LIST"
  | "ASSIGNMENTS_LIST"
  | "DEADLINES_LIST"
  | "UPCOMING_LIST"
  | "TODO_LIST"
  | "RECORDINGS_LIST"
  | "CAPTIONS";

export const tabs = [
  ["COURSES_LIST", "내 과목"],
  ["ASSIGNMENTS_LIST", "과제"],
  ["DEADLINES_LIST", "마감일"],
  ["UPCOMING_LIST", "예정 일정"],
  ["TODO_LIST", "Todo"],
  ["RECORDINGS_LIST", "녹화 강의"],
  ["CAPTIONS", "자막 추출"],
] as const satisfies readonly (readonly [SidepanelView, string])[];

export const messages: Record<ErrorCode, string> = {
  LOGIN_REQUIRED:
    "LMS 로그인이 필요합니다. LMS에서 로그인한 뒤 다시 조회하세요.",
  OPEN_LMS: "로그인한 LMS 탭을 선택한 뒤 조회하세요.",
  RELOAD_TAB:
    "LMS 탭을 새로고침한 뒤 다시 조회하세요. 확장 설치 직후에는 새로고침이 필요합니다.",
  FORBIDDEN:
    "조회 권한이 없거나 세션이 만료되었습니다. LMS에서 로그인 상태를 확인하세요.",
  NETWORK: "LMS에 연결하지 못했습니다. 잠시 후 다시 시도하세요.",
  TIMEOUT: "조회 시간이 초과되었습니다. 다시 시도하세요.",
  INVALID_RESPONSE: "LMS 응답 형식이 예상과 다릅니다.",
  POLICY: "입력 또는 응답이 안전 정책에 맞지 않아 조회를 중단했습니다.",
  LIMIT: "페이지 수 제한 또는 반복 링크로 조회를 중단했습니다.",
  COURSE_NOT_FOUND:
    "일치하는 과목이 없습니다. 내 과목에서 과목명을 확인하세요.",
  COURSE_AMBIGUOUS:
    "여러 과목이 일치합니다. 전체 과목명을 입력하세요. 이름이 같은 과목은 현재 구분할 수 없습니다.",
  STALE_SELECTION:
    "선택이 만료되었거나 이미 열린 항목입니다. 녹화 목록을 다시 조회하세요.",
  TAB_OPEN_FAILED: "새 탭을 열지 못했습니다. 목록을 다시 조회한 뒤 시도하세요.",
  BUSY: "이전 조회를 처리하고 있습니다. 잠시 후 다시 조회하세요.",
};

export function useSidepanelQuery() {
  const [view, setView] = useState<SidepanelView>("COURSES_LIST");
  const [course, setCourse] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [state, setState] = useState<Result | { status: "idle" | "loading" }>({
    status: "idle",
  });
  const generation = useRef(0);
  const inFlight = useRef<Promise<Result> | null>(null);
  const recordingTarget = useRef<QueryTarget | null>(null);
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
    resetRecordingAction();
    setState({ status: "idle" });
  }
  const courses = useRef<Extract<Result, { courses: unknown }> | null>(null);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  function showCourses() {
    resetRecordingAction();
    setCourse("");
    setView("COURSES_LIST");
    if (courses.current) {
      generation.current++;
      setState(courses.current);
    } else {
      void load({ version: 1, type: "COURSES_LIST" });
    }
  }
  async function load(query: Request) {
    if (!isRequest(query)) {
      clear();
      return;
    }
    const current = ++generation.current;
    resetRecordingAction();
    setState({ status: "loading" });
    // Finish the active request, then execute only the latest selected view.
    if (inFlight.current) await inFlight.current;
    if (current !== generation.current) return;
    const work =
      query.type === "RECORDINGS_LIST"
        ? queryActive(query, {
            onTarget: (target) => {
              if (current === generation.current)
                recordingTarget.current = target;
            },
          })
        : queryActive(query);
    inFlight.current = work;
    const result = await work;
    if (inFlight.current === work) inFlight.current = null;
    if (current === generation.current) {
      if (result.status === "success" && "courses" in result)
        courses.current = result;
      if (
        result.status === "error" &&
        ["LOGIN_REQUIRED", "FORBIDDEN"].includes(result.code)
      )
        courses.current = null;
      setState(result);
    }
  }
  async function openRecording(handle: string) {
    if (opening.current || inFlight.current || recordingAction.used.has(handle))
      return;
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
    const work = queryActive(
      { version: 1, type: "RECORDING_OPEN", handle },
      { target },
    );
    inFlight.current = work;
    const result = await work;
    if (inFlight.current === work) inFlight.current = null;
    opening.current = false;
    if (current !== generation.current) return;
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
          ? "새 LMS/LTI 탭을 열었습니다."
          : messages[result.code],
    }));
  }
  const needsCourse =
    view === "ASSIGNMENTS_LIST" ||
    view === "DEADLINES_LIST" ||
    view === "RECORDINGS_LIST";
  const query: Request = needsCourse
    ? { version: 1, type: view, course }
    : view === "UPCOMING_LIST"
      ? {
          version: 1,
          type: view,
          ...(start ? { start_date: start } : {}),
          ...(end ? { end_date: end } : {}),
        }
      : { version: 1, type: view === "CAPTIONS" ? "COURSES_LIST" : view };
  return {
    view,
    setView,
    course,
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
    needsCourse,
    query,
    isQueryValid: isRequest(query),
  };
}
