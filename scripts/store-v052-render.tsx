import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import fs from "node:fs";
import { Rail } from "../entrypoints/sidepanel/ui/Rail";
import { CoursesScreen } from "../entrypoints/sidepanel/screens/CoursesScreen";
import { TasksScreen } from "../entrypoints/sidepanel/screens/TasksScreen";
import type { PanelModel } from "../entrypoints/sidepanel/screens/QueryResults";
import type { Result } from "../src/protocol";

// Store screenshots render the real side-panel components (rail, screens,
// result lists) with the real stylesheet and public, made-up data. They are
// samples, not LMS captures; every scene says so next to the panel.
const css = fs.readFileSync("entrypoints/sidepanel/style.css", "utf8");
const noop = () => {};
const day = 86400000;
// Dates relative to the render time, so chips read like a normal week.
const at = (days: number, hour = 23, minute = 59) => {
  const date = new Date(Date.now() + days * day);
  date.setHours(hour, minute, 0, 0);
  return date.toISOString();
};
const handle = (index: number) =>
  `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;

// Only the fields the rendered screens read; nothing here can load or open.
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
const assignment = (
  title: string,
  dueDays: number,
  submitted = false,
): Extract<Result, { assignments: unknown }>["assignments"][number] => ({
  title,
  due_at: at(dueDays),
  remaining_candidate: !submitted && dueDays >= 0,
  unlock_at: "",
  lock_at: "",
  points_possible: 10,
  published: true,
  locked_for_user: false,
  submission_workflow_state: submitted ? "submitted" : "unsubmitted",
  submitted_at: submitted ? at(dueDays - 1, 20, 10) : "",
  missing: false,
  late: false,
  submission_types: ["online_upload"],
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
const upcoming = (title: string, type: string, days: number, from: string) => ({
  title,
  date: at(
    days,
    type === "announcement" ? 9 : 23,
    type === "announcement" ? 0 : 59,
  ),
  type,
  course: from,
  submitted: false,
  new_activity: type === "announcement",
});

const scenes: {
  file: string;
  headline: string;
  section: "courses" | "tasks";
  screen: ReactNode;
}[] = [
  {
    file: "assignments",
    headline: "과제와 마감일을<br>한눈에 확인하세요.",
    section: "courses",
    screen: (
      <CoursesScreen
        model={model({
          course,
          view: "ASSIGNMENTS_LIST",
          state: {
            status: "success",
            assignments: [
              assignment("과제 4 · 해시 테이블 구현", 0),
              assignment("실습 보고서 6", 5),
              assignment("과제 5 · 그래프 탐색", 9),
              assignment("기말 프로젝트 제안서", 16),
              assignment("과제 3 · 이진 탐색 트리", -4, true),
            ],
          },
        })}
      />
    ),
  },
  {
    file: "recordings",
    headline: "주차학습과 게시판의<br>녹화 강의를 함께 찾으세요.",
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
    file: "schedule",
    headline: "일정을 과제·공지로<br>나눠서 보세요.",
    section: "tasks",
    screen: (
      <TasksScreen
        model={model({
          view: "UPCOMING_LIST",
          tasksMode: "upcoming",
          state: {
            status: "success",
            upcoming: [
              upcoming("휴강 및 보강 안내", "announcement", 1, "자료구조"),
              upcoming(
                "과제 4 · 해시 테이블 구현",
                "assignment",
                2,
                "자료구조",
              ),
              upcoming("퀴즈 3", "quiz", 3, "확률과 통계"),
              upcoming("중간고사 성적 공지", "announcement", 4, "선형대수"),
              upcoming(
                "토론 · 정렬 알고리즘 비교",
                "discussion_topic",
                6,
                "자료구조",
              ),
              upcoming("학과 세미나", "calendar_event", 8, "선형대수"),
            ],
          },
        })}
      />
    ),
  },
];

scenes.push({
  file: "materials",
  headline: "강의 자료를<br>한 번에 모으세요.",
  section: "courses",
  screen: (
    <CoursesScreen
      model={model({
        course,
        view: "DOCUMENTS_LIST",
        state: {
          status: "success",
          documents: [
            {
              module: "7주차",
              title: "힙과 우선순위 큐",
              filename: "07_Heap.pdf",
              type: "File",
              lmsHandle: handle(30),
              downloadHandle: handle(31),
            },
            {
              module: "7주차",
              title: "실습 · 우선순위 큐",
              filename: "07_Practice.pdf",
              type: "File",
              lmsHandle: handle(32),
              downloadHandle: handle(33),
            },
            {
              module: "8주차",
              title: "해시 테이블",
              filename: "08_HashTable.pptx",
              type: "File",
              lmsHandle: handle(34),
              downloadHandle: handle(35),
            },
            {
              module: "게시판 · 강의자료실",
              title: "중간고사 복습 자료",
              filename: "Review.pdf",
              type: "File",
              lmsHandle: handle(36),
              downloadHandle: handle(37),
            },
          ],
        },
      })}
    />
  ),
});
const out = "store/assets/v0.5.2";
fs.mkdirSync(out, { recursive: true });
const copy = [
  [
    "01",
    "과제 · 마감",
    "마감은 한눈에.<br>과제는 놓치지 않게.",
    "미제출 과제와 남은 기한을 확인하고,<br>오늘 해야 할 일에 집중하세요.",
    "미제출 과제 확인",
    "남은 기한 한눈에",
  ],
  [
    "02",
    "녹화 강의",
    "찾던 녹화 강의,<br>여기 다 모였어요.",
    "주차학습부터 게시판 녹화까지.<br>과목별 강의 목록에서 바로 찾아보세요.",
    "주차학습 + 게시판",
    "LMS에서 바로 열기",
  ],
  [
    "03",
    "할 일 · 일정",
    "여러 과목 일정도,<br>한곳에서 한눈에.",
    "과제, 퀴즈, 공지를 모아 확인하세요.<br>이번 주 학습 계획이 더 간단해집니다.",
    "과목별 일정 모아보기",
    "과제와 공지 구분",
  ],
  [
    "04",
    "강의 자료",
    "자료 찾는 시간은 줄이고,<br>공부할 시간은 늘리고.",
    "흩어진 PDF와 PPT를 모아 보고,<br>필요한 강의 자료를 한 번에 내려받으세요.",
    "주차학습 + 게시판 자료",
    "자료 전체 다운로드",
  ],
];
for (const [i, scene] of scenes.entries()) {
  const [num, label, title, desc, tag1, tag2] = copy[i];
  const panel = renderToStaticMarkup(
    <>
      <Rail
        section={scene.section}
        onSelect={noop}
        onInfo={noop}
        playbackAvailable={false}
      />
      <main>{scene.screen}</main>
    </>,
  );
  fs.writeFileSync(
    `${out}/${scene.file}-panel.html`,
    `<!doctype html><html lang="ko"><meta charset="utf-8"><style>${css}html,body{margin:0;width:100%;min-height:100%;}body{overflow:hidden}</style>${panel}</html>`,
  );
  fs.writeFileSync(
    `${out}/${num}-${scene.file}.html`,
    `<!doctype html><html lang="ko"><meta charset="utf-8"><style>
 *{box-sizing:border-box}body{margin:0;width:1280px;height:800px;overflow:hidden;background:#faf8f6;color:#241b21;font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo",sans-serif}
 .brand{position:absolute;left:66px;top:46px;display:flex;align-items:center;gap:12px;font-weight:700;font-size:28px;letter-spacing:-1px}.brand img{width:42px;height:42px}.version{position:absolute;right:64px;top:57px;font-size:14px;color:#6d5963;letter-spacing:2px}
 .copy{position:absolute;left:66px;top:218px;width:570px}.label{font-size:16px;font-weight:700;color:#872038;letter-spacing:1px;margin-bottom:25px}h1{font-size:${i === 3 ? 43 : 49}px;line-height:1.25;letter-spacing:-2.4px;margin:0 0 27px;font-weight:750}.desc{font-size:20px;color:#766671;line-height:1.7;margin:0}.tags{display:flex;gap:9px;margin-top:34px}.tags span{padding:10px 15px;background:#efe8e9;border-radius:30px;color:#75354a;font-size:14px;font-weight:600}
 .stage{position:absolute;left:675px;top:116px;width:539px;height:607px;border-radius:34px;background:radial-gradient(ellipse at 8% 90%,#f6c9a8,transparent 65%),radial-gradient(ellipse at 95% 8%,#ba6f90,transparent 65%),linear-gradient(145deg,#ecd3d6,#872038);box-shadow:inset 0 1px 0 #ffffff80;}
 .window{position:absolute;left:43px;top:27px;width:453px;height:555px;background:#f1f1f3;border:1px solid #ffffffaa;border-radius:19px;overflow:hidden;box-shadow:0 25px 45px #42132340}.bar{height:37px;display:flex;align-items:center;padding:0 16px;gap:6px;background:#faf8f9;border-bottom:1px solid #e3dce0}.dot{width:7px;height:7px;border-radius:50%;background:#d9cdd2}.bar b{font-size:11px;font-weight:500;color:#897780;margin:auto;transform:translateX(-15px)}iframe{display:block;width:530px;height:607px;border:0;transform:scale(.851);transform-origin:top left}
 .foot{position:absolute;left:66px;bottom:42px;font-size:12px;color:#8d7e86;line-height:1.7}.url{position:absolute;right:67px;bottom:42px;font-size:14px;color:#77636e}
 </style><div class="brand"><img src="../../../public/icons/128.png">uniDock</div><div class="version">CHROME EXTENSION · v0.5.2</div><section class="copy"><div class="label">${num} / ${label}</div><h1>${title}</h1><p class="desc">${desc}</p><div class="tags"><span>${tag1}</span><span>${tag2}</span></div></section><div class="stage"><div class="window"><div class="bar"><i class="dot"></i><i class="dot"></i><i class="dot"></i><b>uniDock · 사이드 패널</b></div><iframe src="${scene.file}-panel.html"></iframe></div></div><div class="foot">실제 v0.5.2 UI · 예시 데이터<br>고려대학교와 제휴하지 않은 비공식 확장 프로그램</div><div class="url">unidock.co.kr</div></html>`,
  );
}
