import { renderToStaticMarkup } from "react-dom/server";
import fs from "node:fs";
import { ResultList } from "../entrypoints/sidepanel/ResultList";
import fixture from "../tests/fixtures/python-contract.json";
const css = fs.readFileSync("entrypoints/sidepanel/style.css", "utf8");
const header = (
  <header>
    <span
      className="mark"
      style={{ backgroundImage: "url('../../public/icons/128.png')" }}
    >
      u
    </span>
    <h1>uniDock</h1>
    <span className="badge">읽기 전용</span>
  </header>
);
for (const kind of ["assignments", "recordings"] as const) {
  const result =
    kind === "assignments"
      ? {
          status: "success" as const,
          assignments: fixture.expected.assignments,
        }
      : {
          status: "success" as const,
          recordings: [
            {
              module: "1주차",
              title: "1주차 1차시",
              type: "ExternalTool" as const,
              source: "module" as const,
              lmsHandle: "sample-1",
              launchHandle: "sample-2",
            },
            {
              module: "1주차",
              title: "1주차 2차시",
              type: "ExternalTool" as const,
              source: "module" as const,
              lmsHandle: "sample-3",
              launchHandle: "sample-4",
            },
          ],
        };
  const markup = renderToStaticMarkup(
    <main>
      {header}
      <h3>{kind === "assignments" ? "과제" : "녹화 강의"}</h3>
      <ResultList result={result} onCourse={() => {}} onRecording={() => {}} />
      <footer>
        실제 컴포넌트 · 공개 가상 fixture
        <br />
        자동재생 및 제출 기능 없음
      </footer>
    </main>,
  );
  fs.writeFileSync(
    `store/assets/${kind}.html`,
    `<!doctype html><html lang="ko"><meta charset="utf-8"><style>${css}body{width:1280px;height:800px;display:flex;align-items:center;justify-content:center;gap:100px;background:#eee9e8}aside{width:480px}aside h1{font-size:64px}aside p{font-size:22px;line-height:1.8}main{width:380px;max-height:750px;overflow:hidden;background:#f8f7f5;border:1px solid #ded7d8;border-radius:20px;margin:0;box-shadow:0 20px 60px #4f29351c}</style><aside><h1>uniDock</h1><p>${kind === "assignments" ? "과제와 마감일을<br>한눈에 확인하세요." : "녹화 강의를 찾고<br>LMS에서 직접 여세요."}</p><p style="font-size:14px;color:#766c70">실제 UI 구성요소를 사용한 샘플 화면<br>고려대학교와 제휴하지 않은 비공식 확장</p></aside>${markup}</html>`,
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
