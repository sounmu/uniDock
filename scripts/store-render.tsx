import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'node:fs';
import { ResultList } from '../entrypoints/sidepanel/ResultList';
import fixture from '../tests/fixtures/python-contract.json';
const css = fs.readFileSync('entrypoints/sidepanel/style.css','utf8');
const header = <header><span className="mark" style={{backgroundImage:"url('../../public/icons/128.png')"}}>u</span><h1>uniDock</h1><span className="badge">읽기 전용</span></header>;
for (const kind of ['assignments','recordings'] as const) {
  const result = kind === 'assignments' ? {status:'success' as const,assignments:fixture.expected.assignments} : {status:'success' as const,recordings:[{module:'1주차',title:'1주차 1차시',type:'ExternalTool' as const,lmsHandle:'sample-1',launchHandle:'sample-2'},{module:'1주차',title:'1주차 2차시',type:'ExternalTool' as const,lmsHandle:'sample-3',launchHandle:'sample-4'}]};
  const markup=renderToStaticMarkup(<main>{header}<h3>{kind==='assignments'?'과제':'녹화 강의'}</h3><ResultList result={result} onCourse={() => {}} onRecording={() => {}}/><footer>실제 컴포넌트 · 공개 가상 fixture<br/>자동재생 및 제출 기능 없음</footer></main>);
  fs.writeFileSync(`store/assets/${kind}.html`,`<!doctype html><html lang="ko"><meta charset="utf-8"><style>${css}body{width:1280px;height:800px;display:flex;align-items:center;justify-content:center;gap:100px;background:#eee9e8}aside{width:480px}aside h1{font-size:64px}aside p{font-size:22px;line-height:1.8}main{width:380px;max-height:750px;overflow:hidden;background:#f8f7f5;border:1px solid #ded7d8;border-radius:20px;margin:0;box-shadow:0 20px 60px #4f29351c}</style><aside><h1>uniDock</h1><p>${kind==='assignments'?'과제와 마감일을<br>한눈에 확인하세요.':'녹화 강의를 찾고<br>LMS에서 직접 여세요.'}</p><p style="font-size:14px;color:#766c70">실제 UI 구성요소를 사용한 샘플 화면<br>고려대학교와 제휴하지 않은 비공식 확장</p></aside>${markup}</html>`);
}

fs.writeFileSync('store/assets/promo.html','<!doctype html><meta charset="utf-8"><style>body{margin:0;width:880px;height:560px;background:#872038;display:grid;place-items:center}img{width:320px;height:320px}</style><img src="../../public/icons/128.png" alt="u">');
