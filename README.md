# uniDock

고려대학교 LMS를 기존 로그인 세션으로 조회하는 Chrome Manifest V3 확장 프로그램. WXT + React + TypeScript, Chrome 114 이상 Side Panel UI.

## 설치 및 실행

Node.js 22.13 이상(권장 24 LTS), npm을 설치하고 이 디렉터리에서 실행합니다.

```sh
npm ci
npm run check
```

1. Chrome에서 `chrome://extensions`를 열고 개발자 모드를 켭니다.
2. **압축해제된 확장 프로그램을 로드합니다**에서 `.output/chrome-mv3` 폴더를 선택합니다.
3. 도구 모음에 고정한 uniDock 아이콘을 눌러 Side Panel을 엽니다.
4. 일반 Chrome 탭에서 `https://mylms.korea.ac.kr/`를 열고 평소처럼 LMS/SSO에 로그인합니다. 확장은 로그인 입력을 받거나 조작하지 않습니다.
5. 기존 LMS 탭을 새로고침한 뒤 해당 탭을 선택하고 패널에서 조회합니다.

재빌드 후에는 확장 관리 화면에서 확장을 다시 로드하고 LMS 탭도 새로고침합니다. Chrome 114에서 도구 모음 클릭이 동작하지 않으면 브라우저 Side Panel 선택 메뉴에서 uniDock을 선택합니다. `sidePanel.open()`(116+)은 사용하지 않습니다.

```sh
npm run dev        # WXT 개발용 브라우저/HMR; 별도 프로필일 수 있음
npm run lint
npm run typecheck
npm test
npm run build      # 실제 세션 검증에는 production 산출물 사용
```

개발용 HMR은 localhost 연결/개발 권한을 추가할 수 있습니다. 기존 로그인 세션 검증에는 production unpacked 확장을 사용하세요.

## 조회 기능

| 화면 | 입력 | 조회 결과 |
| --- | --- | --- |
| 내 과목 | 없음 | 활성 과목명, 과제 보기 버튼 |
| 과제 | 과목명 | 제목, 마감, 제출 상태, 잠김·누락·지각 여부, 남은 후보 |
| 마감일 | 과목명 | **모든 과제**의 제목·마감·남은 후보 |
| Upcoming | 선택적 시작일·종료일 | Planner 일정, 과목, 제출 기록, 새 활동 |
| Todo | 없음 | 할 일 제목·마감·과목·ignore 상태 |

과목명을 일부 입력하면 대소문자를 무시하고 검색합니다. 여러 과목이 일치하면 전체 이름과 정확히 일치하는 하나를 우선합니다. 정확한 이름도 중복되면 오류로 종료합니다. 내부 course ID로 사용자가 직접 선택하거나 임의 endpoint를 요청할 수 없습니다. 이름은 매 과제/마감일 조회 때 content script에서 다시 해석하므로 ID 매핑을 저장하지 않습니다.

Python live 구현과 동일하게 API 순서를 보존하며, 마감일 목록을 자동 정렬하거나 미제출 과제만 필터링하지 않습니다. `remaining_candidate`는 다음 조건일 때만 true입니다.

- 마감 시간이 조회 시작 시각보다 미래
- `locked_for_user`가 false
- `submitted_at`이 없음
- 제출 workflow가 `submitted` 또는 `graded`가 아님

마감 시간이 없거나 해석할 수 없으면 false입니다. 시간대 없는 ISO 날짜는 Python처럼 UTC로 해석하며 UI는 한국 시간으로 표시합니다. 이 값은 **후보 판정**으로, 실제 제출 가능 여부를 보장하지 않습니다. 원본과 동일하게 `published`, `unlock_at`, `lock_at`으로 추가 필터링하지 않습니다.

Upcoming은 `/planner/items`의 응답을 표시합니다. 날짜를 비우면 Canvas의 기본 조회 범위를 사용합니다. 입력 날짜를 로컬 시각으로 변환하지 않고 `YYYY-MM-DD`로 전달합니다. Todo의 `ignore`는 읽어서 표시만 하며 숨김/완료/제출 동작은 없습니다.

## 구조와 안전 경계

- `entrypoints/background.ts`: 도구 모음 → Side Panel 설정.
- `entrypoints/sidepanel/`: 기능 선택, 입력, 상태 UI, 결과 렌더링.
- `entrypoints/lms.content.ts`: 허용 LMS 최상위 프레임의 isolated world에서 사용자 요청 처리.
- `src/transport.ts`, `src/protocol.ts`: 요청 종류별 닫힌 스키마, sender 검증, 응답 종류/필드 검증, 시간 제한.
- `src/api/`: GET 전용 API, 과목명 해석, Link 페이지네이션.
- `src/domain.ts`, `src/domain-items.ts`: 공개 모델, 필드 투영, 날짜와 남은 후보 계산.
- `src/security/`: 출처/경로/쿼리 제한, redaction, 정적 이벤트 코드 로깅.

패널 → `tabs.sendMessage` → LMS content script → 동일 출처 Fetch 순서입니다. `credentials: same-origin`으로 브라우저가 해당 세션 쿠키를 자동 첨부합니다. 쿠키를 직접 읽거나 저장하지 않습니다. 백그라운드 범용 HTTP proxy는 없습니다.

허용되는 GET 경로는 아래 네 가지뿐입니다.

```text
/api/v1/courses?per_page=100&enrollment_state=active
/api/v1/courses/{내부에서 확인한 ID}/assignments?per_page=100&include[]=submission
/api/v1/planner/items?per_page=100[&start_date=YYYY-MM-DD&end_date=YYYY-MM-DD]
/api/v1/users/self/todo?per_page=100
```

각 페이지는 동일 출처·동일 경로만 허용합니다. 다음 과목/다른 API로 이동하는 링크, 알 수 없는 쿼리, 토큰 쿼리, 리다이렉트는 차단합니다. `page`는 양의 정수, `per_page`는 1–100으로 제한합니다. 알려지지 않은 opaque 페이지 파라미터가 오면 안전하게 중단합니다. 전체 20초/100페이지 예산에 과목명 해석도 포함하며, 각 목록 10,000건 제한입니다. 페이지 오류 때 부분 결과를 성공으로 표시하지 않습니다. 메시지는 23초 제한이고, 같은 요청은 합치며 다른 동시 요청은 BUSY로 종료합니다.

Chrome 권한은 `sidePanel`과 두 호스트 `https://mylms.korea.ac.kr/*`, `https://canvas.korea.ac.kr/*`뿐입니다. `cookies`, `storage`, `tabs`, `scripting`, `activeTab`, 광범위 호스트 권한은 없습니다. 호스트 권한으로 해당 탭의 URL을 검사합니다. SSO/LTI 호스트 권한도 없습니다.

원본 응답은 처리 중 메모리에만 존재합니다. 메시지에는 필요한 공개 필드만 보내고 ID·URL·본문·첨부·토큰 등 나머지는 제거합니다. 텍스트 내 알려진 ID·URL·이메일·secret 패턴은 치환합니다. 범용 문자열 필터가 모든 임의 비밀을 판별할 수는 없으므로 로거는 정적 이벤트 코드만 받습니다. 오류 객체나 원본 응답은 출력하지 않습니다.

파일, Chrome storage, local/session storage, IndexedDB, telemetry에 LMS 데이터를 저장하지 않습니다. Fetch는 `cache: no-store`입니다. 목록은 패널 메모리에만 남고 탭 전환·페이지 로딩·다음 조회·기능/필터 변경 때 지워집니다. 브라우저 자체 네트워크 기록까지 제어하지는 않습니다.

과제 제출, 업로드, 글쓰기, 댓글, 수정, 삭제, 수강 변경, 영상 자동재생/keepalive/출석 자동화는 구현하지 않습니다. CLI의 자료 다운로드·일반 캘린더 이벤트·feed·자막은 현재 범위 밖입니다.

## Python 계약 테스트

`tests/fixtures/python-contract.json`은 `../ku-lms-cli/tests/test_live_provider.py::FakeSession`의 **공개 가상 데이터**에서 생성했습니다. `scripts/generate_contract.py`는 지정된 공개 소스 두 파일만 읽습니다. AST로 fixture 리터럴과 공개 변환 함수/마감일 메서드만 추출해 실행하며, 참조 모듈을 import하거나 로그인/provider를 생성하지 않습니다. env·자격 증명·discovery 파일을 읽거나 참조 저장소에 쓰지 않습니다.

Python `_public_assignment`, `_public_planner_item`, `_public_todo_item`, `_remaining_candidate`, `LiveLmsProvider.deadlines`의 결과를 기대값으로 고정합니다. 기준 시각은 `2026-09-11T00:00:00Z`이며 원본 파일 SHA-256도 기록합니다. 원본 fixture 외에도 누락/null 필드, 제출/채점/잠김, 과거/미래/경계 마감, UTC 기본값, 시차, 잘못된 날짜, 제목 fallback을 Python으로 계산한 사례를 포함합니다.

```sh
npm test                  # Node만 필요. golden JSON으로 전체 필드와 API 결과 계약 비교
npm run contract:check    # 선택적 개발 검증: Python 3.10+ 및 읽기 전용 참조 저장소 필요
npm run contract:refresh  # 참조 변경을 검토한 뒤 golden 갱신
```

`contract:check`는 현재 Python 소스에서 재계산한 결과와 golden이 정확히 같은지 확인하고, 차이가 있으면 실패합니다. 참조 경로가 다르면 `python3 -B scripts/generate_contract.py --check /path/to/ku-lms-cli`로 실행할 수 있습니다. Python은 개발용 golden 생성에만 사용하며 확장 런타임/빌드에는 포함되지 않습니다. 일반 단위 테스트는 참조 저장소 없이 실행됩니다.

공개 정상 fixture 결과는 Python과 동일합니다. 민감정보가 텍스트에 섞인 응답은 확장의 더 엄격한 redaction을 적용하므로 의도적으로 원문과 다릅니다. 모든 Python 입력 타입/ISO 표기 변형에 대한 완전한 호환을 주장하지 않으며 Canvas의 ISO 날짜 형식을 지원합니다.

## 수동 LMS 검증

실제 로그인된 LMS 호출과 Chrome 114 실기기 검증은 아직 수행하지 않았습니다.

1. production 빌드를 로드하고 LMS 탭을 새로고침합니다. 로그인 전 조회 시 로그인/권한 안내를 확인합니다.
2. LMS에서 직접 로그인한 뒤 **내 과목 → 과제 보기**로 실제 과제명·마감·제출 상태를 LMS 화면과 비교합니다.
3. 같은 과목의 **마감일**에서 과제 순서와 전체 행 수가 과제 목록과 같은지 확인합니다. 제출/마감 완료된 행도 사라지지 않아야 합니다.
4. **Upcoming**에서 날짜 없이 조회한 뒤 시작일·종료일을 지정해 조회합니다. **Todo**의 할 일 제목·마감을 LMS와 비교합니다. 숨김/완료 버튼은 없어야 합니다.
5. 과목명 일부와 없는 과목명을 입력해 선택 오류를 확인합니다. 종료일이 시작일보다 빠르면 조회가 비활성화되어야 합니다.
6. 여러 페이지가 있으면 마지막 항목까지 표시되는지 확인합니다. LMS 로그아웃 후 다시 조회하면 기존 목록 대신 안내가 보여야 합니다. 동일 문서 내 로그아웃은 다음 조회 때 반영될 수 있습니다.
7. 일반 사이트 탭에서는 LMS 탭 안내, 네트워크 끊김에는 오류/시간 초과, 미갱신 탭에는 새로고침 안내를 확인합니다.
8. 필요하면 DevTools에서 GET 메서드와 상태 코드만 육안 확인합니다. 원본 응답·헤더·쿠키·HAR·민감한 스크린샷을 저장/공유하지 않습니다. 확장 콘솔과 저장소에 LMS 데이터가 기록되지 않는지 확인합니다.

LMS가 iframe 내부에만 있으면 실제 최상위 LMS 탭을 열어야 합니다. 실 서비스 API/SSO 변화와 Chrome Web Store 심사는 별도 검증이 필요합니다.

## 공식 참고 자료

2026-09-11 확인. 패키지 정확한 버전은 `package.json`과 `package-lock.json`에 고정합니다.

- [Chrome Side Panel](https://developer.chrome.com/docs/extensions/reference/api/sidePanel), [메시징](https://developer.chrome.com/docs/extensions/develop/concepts/messaging), [네트워크](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests), [Tabs 호스트 권한](https://developer.chrome.com/docs/extensions/reference/api/tabs)
- [WXT entrypoints](https://wxt.dev/guide/essentials/entrypoints.html), [manifest](https://wxt.dev/guide/essentials/config/manifest.html), [npm 공식 registry](https://registry.npmjs.org/)
- [Canvas Assignments](https://developerdocs.instructure.com/services/canvas/resources/assignments), [Planner](https://developerdocs.instructure.com/services/canvas/resources/planner), [Users / Todo](https://developerdocs.instructure.com/services/canvas/resources/users), [Pagination](https://developerdocs.instructure.com/services/canvas/basics/file.pagination)

## 검증 결과

- `npm run check`: lint, typecheck, 단위/계약/정적 UI 렌더링 테스트 **98개(6개 파일)**, production build 통과.
- `npm run contract:check`: 현재 읽기 전용 Python 참조의 계산 결과 및 소스 해시와 일치.
- production manifest: `sidePanel`과 기존 LMS 두 호스트만 유지, Chrome 114 minimum 유지.
- 참조 저장소 `git status --porcelain`: 변경 없음.
- 실제 LMS 세션 요청 및 브라우저 UI 육안 검증: 미실시. 위 수동 절차로 확인 필요.
