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

const course = "자료구조 (가상 과목)";
const assignment = (
  title: string,
  dueDays: number,
  submitted = false,
): Extract<Result, { assignments: unknown }>["assignments"][number] => ({
  title,
  due_at: at(dueDays),
  remaining_candidate: !submitted && dueDays > 0,
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
              assignment("과제 4 · 해시 테이블 구현", 2),
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

for (const scene of scenes) {
  const panel = renderToStaticMarkup(
    <div className="store-panel">
      <Rail
        section={scene.section}
        onSelect={noop}
        onInfo={noop}
        playbackAvailable={false}
      />
      <main>{scene.screen}</main>
    </div>,
  );
  fs.writeFileSync(
    `store/assets/${scene.file}.html`,
    `<!doctype html><html lang="ko"><meta charset="utf-8"><style>${css}
html,body{width:1280px;height:800px;overflow:hidden}
body{display:flex;align-items:center;justify-content:center;gap:96px;background:#eee9e8;font-family:var(--font);color:var(--text, #1f1d22)}
aside{width:500px}
aside .brand{display:flex;align-items:center;gap:16px;margin-bottom:28px}
aside .brand img{width:64px;height:64px}
aside .brand span{font-size:44px;font-weight:700;letter-spacing:-0.02em}
aside h1{font-size:40px;line-height:1.35;margin:0 0 24px;letter-spacing:-0.02em}
aside p{font-size:15px;line-height:1.7;color:#766c70;margin:0}
.store-panel{width:400px;height:720px;overflow:hidden;background:var(--page);border:1px solid #ded7d8;border-radius:20px;box-shadow:0 24px 64px #4f29352a}
.store-panel main{padding-bottom:0}
</style><aside><div class="brand"><img src="../../public/icons/128.png" alt=""><span>uniDock</span></div><h1>${scene.headline}</h1><p>실제 UI 구성요소와 가상 데이터로 만든 샘플 화면입니다.<br>고려대학교와 제휴하지 않은 비공식 확장입니다.</p></aside>${panel}</html>`,
  );
}

const promoLogo = fs
  .readFileSync("store/assets/logo-concepts/unidock-glass.svg", "utf8")
  .replace(
    '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"',
    '<svg x="128" y="48" width="184" height="184"',
  );
fs.writeFileSync(
  "store/assets/promo.html",
  `<!doctype html><meta charset="utf-8"><style>body{margin:0}svg{display:block}</style><svg xmlns="http://www.w3.org/2000/svg" width="880" height="560" viewBox="0 0 440 280"><defs><radialGradient id="rose-glow"><stop stop-color="#E7C8D3" stop-opacity="0.65"/><stop offset="1" stop-color="#E7C8D3" stop-opacity="0"/></radialGradient></defs><rect width="440" height="280" fill="#F5F1ED"/><ellipse cx="220" cy="140" rx="210" ry="170" fill="url(#rose-glow)"/>${promoLogo}</svg>`,
);
