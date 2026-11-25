// Synthetic LMS for the unidock.co.kr demo. These are the projected rows the
// LMS content script would answer the panel with (src/protocol-fields.ts), so
// the real transport, parser and screens run unchanged.
export const lmsTab = {
  id: 3,
  windowId: 1,
  url: "https://mylms.korea.ac.kr/courses/101/modules",
  title: "자료구조 · 주차학습",
};
const day = 86400000;
// The panel shows dates in Asia/Seoul (UTC+9, no DST), so build each time from
// the Korean calendar date rather than the visitor's local one.
const seoulOffset = 9 * 3600000;
const at = (days, hour = 23, minute = 59) => {
  const date = new Date(Date.now() + seoulOffset + days * day);
  const utc = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hour, minute);
  return new Date(utc - seoulOffset).toISOString();
};
const handle = (index) =>
  `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const course = "자료구조";
const courses = [course, "선형대수", "컴퓨터구조"].map((name, index) => ({
  name,
  courseSelector: handle(80 + index),
}));
const todo = (title, dueDays, from) => ({
  title,
  due_at: at(dueDays),
  type: "unsubmitted",
  course: from,
  ignore: false,
});
const upcoming = (title, days, from, type, submitted = false) => ({
  title,
  date: at(days),
  type,
  course: from,
  submitted,
  new_activity: false,
});
const recording = (index, module, title, source) => ({
  module,
  title,
  type: "ExternalTool",
  source,
  lmsHandle: handle(index * 2),
  launchHandle: handle(index * 2 + 1),
});
const documentItem = (index, module, title, filename) => ({
  module,
  title,
  filename,
  type: "File",
  lmsHandle: handle(30 + index * 2),
  downloadHandle: handle(31 + index * 2),
});
// Due dates are relative to page load, like the extension shows them.
const data = {
  todo: [
    todo("과제 4 · 해시 테이블 구현", 0, "자료구조"),
    todo("퀴즈 3", 1, "선형대수"),
    todo("실습 보고서 6", 5, "컴퓨터구조"),
    todo("토론 · 3주차 읽기 자료", 7, "정보사회와 윤리"),
    todo("기말 프로젝트 제안서", 16, "소프트웨어공학"),
  ],
  upcoming: [
    upcoming("실습 보고서 5", -2, "컴퓨터구조", "assignment", true),
    upcoming("과제 4 · 해시 테이블 구현", 0, "자료구조", "assignment"),
    upcoming("퀴즈 3", 1, "선형대수", "quiz"),
    upcoming("중간고사 보강 안내", 3, "자료구조", "calendar_event"),
    upcoming("실습 보고서 6", 5, "컴퓨터구조", "assignment"),
    upcoming("기말 프로젝트 제안서", 16, "소프트웨어공학", "assignment"),
  ],
  recordings: [
    recording(1, "7주차", "7주차 1차시 · 힙과 우선순위 큐", "module"),
    recording(2, "8주차", "8주차 1차시 · 해시 함수", "module"),
    recording(3, "게시판 · 강의자료실", "10월 13일 수업 녹화본", "board"),
    recording(4, "게시판 · 강의자료실", "보강 녹화", "board"),
  ],
  documents: [
    documentItem(0, "7주차", "힙과 우선순위 큐", "07_Heap.pdf"),
    documentItem(1, "7주차", "실습 · 우선순위 큐", "07_Practice.pdf"),
    documentItem(2, "8주차", "해시 테이블", "08_HashTable.pptx"),
    documentItem(3, "게시판 · 강의자료실", "중간고사 복습 자료", "Review.pdf"),
  ],
};
const day10 = (value) => value.slice(0, 10);

/** The content script's answer to one panel message (src/protocol.ts). */
export function lmsReply(message) {
  if (message.type === "CAPABILITY_CANCEL") return undefined;
  const request =
    message.type === "CAPABILITY_LIST" ||
    message.type === "QUERY_REFRESH" ||
    message.type === "DOCUMENT_DOWNLOAD_REQUEST"
      ? message.request
      : message;
  const success = (fields) => ({ status: "success", ...fields });
  switch (request.type) {
    case "COURSES_LIST":
      return success({ courses });
    case "TODO_LIST":
      return success({ todo: data.todo });
    case "UPCOMING_LIST":
      return success({
        upcoming: data.upcoming.filter(
          (item) =>
            (!request.start_date || day10(item.date) >= request.start_date) &&
            (!request.end_date || day10(item.date) <= request.end_date),
        ),
      });
    case "ASSIGNMENTS_LIST":
      return success({ assignments: [] });
    case "DEADLINES_LIST":
      return success({ deadlines: [] });
    case "RECORDINGS_LIST":
      return success({
        recordings: data.recordings,
        documentToken: handle(90),
      });
    case "DOCUMENTS_LIST":
      return success({ documents: data.documents });
    case "RECORDING_OPEN":
    case "DOCUMENT_OPEN":
      return success({ opened: true });
    case "DOCUMENT_DOWNLOAD":
      return success({ downloaded: true });
    default:
      throw new Error(`Unexpected demo LMS message: ${message.type}`);
  }
}

const mimes = {
  pdf: "application/pdf",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
/** The finished browser download for one DOCUMENT_DOWNLOAD request. */
export function downloadItem(id, request, path, extensionId) {
  const filename = data.documents.find(
    (item) => item.downloadHandle === request.handle,
  )?.filename;
  if (!filename) throw new Error("Unknown demo download handle");
  return {
    id,
    byExtensionId: extensionId,
    url: `${new globalThis.URL(lmsTab.url).origin}/courses/101/files/${700 + id}/download?download_frd=1`,
    filename: `/Users/demo/Downloads/${path(request.course, filename)}`,
    state: "complete",
    mime: mimes[filename.split(".").pop().toLowerCase()],
  };
}
