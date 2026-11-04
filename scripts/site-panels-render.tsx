import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import fs from "node:fs";
import process from "node:process";
import { Rail, type Section } from "../entrypoints/sidepanel/ui/Rail";
import { CoursesScreen } from "../entrypoints/sidepanel/screens/CoursesScreen";
import { TasksScreen } from "../entrypoints/sidepanel/screens/TasksScreen";
import type { PanelModel } from "../entrypoints/sidepanel/screens/QueryResults";
import type { Result } from "../src/protocol";

// Panel samples for unidock.co.kr (public/panels/*.html). They render the real
// side-panel components with the real stylesheet and made-up data; the site
// shows them in an inert iframe and labels them as samples.
const out = process.env.SITE_PANELS_OUT;
if (!out) throw new Error("SITE_PANELS_OUT is required");
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
  course?: string;
  tasksMode?: "todo" | "upcoming";
}): PanelModel {
  return {
    course: fields.course ?? "",
    selectedCourse: undefined,
    view: fields.view,
    state: fields.state,
    tasksMode: fields.tasksMode ?? "todo",
    start: "",
    end: "",
    query: { version: 1, type: fields.view },
    isQueryValid: true,
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
const todo = (
  title: string,
  dueDays: number,
  from: string,
  type = "unsubmitted",
) => ({
  title,
  due_at: at(dueDays),
  type,
  course: from,
  ignore: false,
});
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
    file: "tasks",
    section: "tasks",
    screen: (
      <TasksScreen
        model={model({
          view: "TODO_LIST",
          tasksMode: "todo",
          state: {
            status: "success",
            todo: [
              todo("과제 4 · 해시 테이블 구현", 0, "자료구조"),
              todo("퀴즈 3", 1, "선형대수"),
              todo("실습 보고서 6", 5, "컴퓨터구조"),
              todo("토론 · 3주차 읽기 자료", 7, "정보사회와 윤리"),
              todo("기말 프로젝트 제안서", 16, "소프트웨어공학"),
            ],
          },
        })}
      />
    ),
  },
  {
    file: "recordings",
    section: "courses",
    screen: (
      <CoursesScreen
        model={model({
          course,
          view: "RECORDINGS_LIST",
          state: {
            status: "success",
            recordings: [
              recording(1, "7주차", "7주차 1차시 · 힙과 우선순위 큐", "module"),
              recording(2, "8주차", "8주차 1차시 · 해시 함수", "module"),
              recording(
                3,
                "게시판 · 강의자료실",
                "10월 13일 수업 녹화본",
                "board",
              ),
              recording(4, "게시판 · 강의자료실", "보강 녹화", "board"),
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
          course,
          view: "DOCUMENTS_LIST",
          state: {
            status: "success",
            documents: [
              documentItem(0, "7주차", "힙과 우선순위 큐", "07_Heap.pdf"),
              documentItem(1, "7주차", "실습 · 우선순위 큐", "07_Practice.pdf"),
              documentItem(2, "8주차", "해시 테이블", "08_HashTable.pptx"),
              documentItem(
                3,
                "게시판 · 강의자료실",
                "중간고사 복습 자료",
                "Review.pdf",
              ),
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
      <Rail
        section={panel.section}
        onSelect={noop}
        onInfo={noop}
        playbackAvailable={__UNIDOCK_PLAYBACK__}
      />
      <main>{panel.screen}</main>
    </>,
  );
  fs.writeFileSync(
    `${out}/${panel.file}.html`,
    `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>uniDock 패널 샘플</title><style>${css}html,body{margin:0;width:100%;min-height:100%;}body{overflow:hidden}</style>${markup}</html>\n`,
  );
}
