import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import fs from "node:fs";
import process from "node:process";
import { Rail, type Section } from "../entrypoints/sidepanel/ui/Rail";
import { HomeScreen } from "../entrypoints/sidepanel/screens/HomeScreen";
import { CoursesScreen } from "../entrypoints/sidepanel/screens/CoursesScreen";
import type { PanelModel } from "../entrypoints/sidepanel/screens/QueryResults";
import type { Result } from "../src/protocol";

// Chrome Web Store screenshots. Panels are the real side-panel components with
// the real stylesheet and made-up data; the frame copy says so.
const out = process.env.STORE_SCREENS_OUT;
if (!out) throw new Error("STORE_SCREENS_OUT is required");
const css = fs.readFileSync("entrypoints/sidepanel/style.css", "utf8");
const noop = () => {};
const day = 86400000;
const at = (days: number, hour = 23, minute = 59) => {
  const date = new Date(Date.now() + days * day);
  date.setHours(hour, minute, 0, 0);
  return date.toISOString();
};
const handle = (index: number) =>
  `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;

function model(fields: {
  view: PanelModel["view"];
  state: Result;
  section: Section;
  course?: string;
  tasksMode?: "todo" | "upcoming";
}): PanelModel {
  return {
    section: fields.section,
    course: fields.course ?? "",
    selectedCourse: undefined,
    view: fields.view,
    state: fields.state,
    tasksMode: fields.tasksMode ?? "todo",
    start: "",
    end: "",
    query: { version: 1, type: fields.view },
    isQueryValid: true,
    updatedAt: Date.now() - 2 * 60_000,
    recordingAction: {
      pending: false,
      notice: "",
      used: new Set<string>(),
      opened: new Set<string>(),
    },
    downloads: {
      statuses: {},
      progress: { running: false, total: 0, done: 0 },
      notice: "",
      downloadDocuments: async () => {},
      cancel: noop,
    },
    clear: noop,
    load: async () => {},
    openRecording: async () => {},
    setCourse: noop,
    setEnd: noop,
    setStart: noop,
    setView: noop,
    showCourses: noop,
  } as unknown as PanelModel;
}

const course = "자료구조";
const todo = (title: string, dueDays: number, from: string, hour = 23) => ({
  title,
  due_at: at(dueDays, hour),
  type: "unsubmitted",
  course: from,
  ignore: false,
});
const todos = [
  todo("과제 4 · 해시 테이블 구현", 0, "자료구조"),
  todo("퀴즈 3", 1, "선형대수", 18),
  todo("실습 보고서 6", 3, "컴퓨터구조"),
  todo("토론 · 3주차 읽기 자료", 6, "정보사회와 윤리"),
  todo("기말 프로젝트 제안서", 12, "소프트웨어공학"),
  todo("과제 5 · 그래프 탐색", 15, "자료구조"),
];
const recording = (
  index: number,
  module: string,
  title: string,
  source: "module" | "board",
) => ({
  module,
  title,
  type: "ExternalTool" as const,
  source,
  lmsHandle: handle(index * 2),
  launchHandle: handle(index * 2 + 1),
});
const documentItem = (
  index: number,
  module: string,
  title: string,
  filename: string,
) => ({
  module,
  title,
  filename,
  type: "File" as const,
  lmsHandle: handle(30 + index * 2),
  downloadHandle: handle(31 + index * 2),
});

const panels: { file: string; section: Section; screen: ReactNode }[] = [
  {
    file: "home",
    section: "home",
    screen: (
      <HomeScreen
        model={model({
          section: "home",
          view: "TODO_LIST",
          state: { status: "success", todo: todos },
        })}
        onTool={noop}
      />
    ),
  },
  {
    file: "recordings",
    section: "courses",
    screen: (
      <CoursesScreen
        model={model({
          section: "courses",
          course,
          view: "RECORDINGS_LIST",
          state: {
            status: "success",
            recordings: [
              recording(1, "7주차", "7주차 1차시 · 힙과 우선순위 큐", "module"),
              recording(2, "7주차", "7주차 2차시 · 힙 정렬", "module"),
              recording(3, "8주차", "8주차 1차시 · 해시 함수", "module"),
              recording(4, "게시판 · 강의자료실", "10월 13일 수업 녹화본", "board"),
              recording(5, "게시판 · 강의자료실", "보강 녹화", "board"),
            ],
          },
        })}
      />
    ),
  },
  {
    file: "materials",
    section: "courses",
    screen: (
      <CoursesScreen
        model={model({
          section: "courses",
          course,
          view: "DOCUMENTS_LIST",
          state: {
            status: "success",
            documents: [
              documentItem(0, "7주차", "힙과 우선순위 큐", "07_Heap.pdf"),
              documentItem(1, "7주차", "실습 · 우선순위 큐", "07_Practice.pdf"),
              documentItem(2, "8주차", "해시 테이블", "08_HashTable.pptx"),
              documentItem(3, "게시판 · 강의자료실", "중간고사 복습 자료", "Review.pdf"),
            ],
          },
        })}
      />
    ),
  },
];

fs.mkdirSync(out, { recursive: true });
for (const panel of panels) {
  const markup = renderToStaticMarkup(
    <>
      <Rail section={panel.section} onSelect={noop} onInfo={noop} />
      <main>{panel.screen}</main>
    </>,
  );
  fs.writeFileSync(
    `${out}/${panel.file}-panel.html`,
    `<!doctype html><html lang="ko"><meta charset="utf-8"><style>${css}html,body{margin:0;width:100%;min-height:100%;}body{overflow:hidden}</style>${markup}</html>\n`,
  );
}
