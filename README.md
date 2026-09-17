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

브라우저 E2E 테스트는 로컬에서 최초 1회 `npx playwright install chromium`으로 Chromium을 설치한 뒤 `npm run test:e2e`로 실행합니다. 이 명령은 production build를 먼저 수행한 다음 `tests/e2e`의 Playwright 테스트를 실행합니다. CI에서는 `npx playwright install --with-deps chromium`으로 설치합니다.

개발용 HMR은 localhost 연결/개발 권한을 추가할 수 있습니다. 기존 로그인 세션 검증에는 production unpacked 확장을 사용하세요.

## 조회 기능

| 화면 | 입력 | 조회 결과 |
| --- | --- | --- |
| 내 과목 | 없음 | 활성 과목명, 과제 보기 버튼 |
| 과제 | 과목명 | 제목, 마감, 제출 상태, 잠김·누락·지각 여부, 남은 후보 |
| 마감일 | 과목명 | **모든 과제**의 제목·마감·남은 후보 |
| Upcoming | 선택적 시작일·종료일 | Planner 일정, 과목, 제출 기록, 새 활동 |
| Todo | 없음 | 할 일 제목·마감·과목·ignore 상태 |
| 녹화 강의 | 과목명 | 모듈별 강의 후보, LMS 모듈 보기, LMS 경유 LTI 탭 열기 |
| 자막 추출 | 사용자가 연 강의 탭 | DOM 우선, XML/VTT 대체 조회 및 시간 포함 TXT·JSON 다운로드 |

과목명을 일부 입력하면 대소문자를 무시하고 검색합니다. 여러 과목이 일치하면 전체 이름과 정확히 일치하는 하나를 우선합니다. 정확한 이름도 중복되면 오류로 종료합니다. 내부 course ID로 사용자가 직접 선택하거나 임의 endpoint를 요청할 수 없습니다. 이름은 매 과제/마감일 조회 때 content script에서 다시 해석하므로 ID 매핑을 저장하지 않습니다.

조회 데이터는 Python live 구현과 동일하게 API 순서와 전체 항목을 보존합니다. 과제·마감일 화면은 기본적으로 ‘남은 과제 후보만’이 체크되며, 체크를 해제하면 전체 항목을 표시합니다. 과제·마감일 화면에서는 사용자가 마감 빠른 순 정렬, 남은 과제 후보만, 이번 주 또는 24시간 이내 필터를 선택할 수 있습니다. 정렬·필터는 전체 조회 결과에 적용한 뒤 페이지를 나누며 원본 응답을 변경하지 않습니다. 이번 주는 한국 시간 월요일 00:00부터 다음 월요일 00:00 직전까지이며, 24시간 이내는 현재 시각 이후부터 24시간 뒤까지입니다. 마감순 정렬에서는 마감이 없거나 해석할 수 없는 항목을 마지막에 표시합니다. 남은 시간과 만료된 후보 표시는 패널에서 갱신하지만 제출·잠금 상태는 새로고침해야 반영됩니다. 과목·과제·일정·녹화 목록은 100개씩 표시하며 이전/다음 버튼으로 전체 결과를 확인합니다. 새 조회 결과에서는 첫 페이지로 돌아갑니다. `remaining_candidate`는 다음 조건일 때만 true입니다.

- 마감 시간이 조회 시작 시각보다 미래
- `locked_for_user`가 false
- `submitted_at`이 없음
- 제출 workflow가 `submitted` 또는 `graded`가 아님

마감 시간이 없거나 해석할 수 없으면 false입니다. 시간대 없는 ISO 날짜는 Python처럼 UTC로 해석하며 UI는 한국 시간으로 표시합니다. 이 값은 **후보 판정**으로, 실제 제출 가능 여부를 보장하지 않습니다. 원본과 동일하게 `published`, `unlock_at`, `lock_at`으로 추가 필터링하지 않습니다.

Upcoming은 `/planner/items`의 응답을 표시합니다. 날짜를 비우면 Canvas의 기본 조회 범위를 사용합니다. 입력 날짜를 로컬 시각으로 변환하지 않고 `YYYY-MM-DD`로 전달합니다. Todo의 `ignore`는 읽어서 표시만 하며 숨김/완료/제출 동작은 없습니다.

## 구조와 안전 경계

- `entrypoints/background.ts`, `src/open-tab.ts`: Side Panel 설정 및 검증된 LMS 주소를 새 탭으로 열기.
- `entrypoints/sidepanel/`: 기능 선택, 입력, 상태 UI, 결과 렌더링.
- `entrypoints/lms.content.ts`: 허용 LMS 최상위 프레임의 isolated world에서 사용자 요청 처리.
- `src/transport.ts`, `src/protocol.ts`: 요청 종류별 닫힌 스키마, sender 검증, 응답 종류/필드 검증, 시간 제한.
- `src/api/`: GET 전용 API, 과목명 해석, Link 페이지네이션.
- `src/domain.ts`, `src/domain-items.ts`: 공개 모델, 필드 투영, 날짜와 남은 후보 계산.
- `src/recordings.ts`, `src/navigation-catalog.ts`: 강의 후보 필터링, 메모리 전용 일회성 선택 키.
- `src/security/`: 출처/경로/쿼리 제한, redaction, 정적 이벤트 코드 로깅.

패널 → `tabs.sendMessage` → LMS content script → 동일 출처 Fetch 순서입니다. `credentials: same-origin`으로 브라우저가 해당 세션 쿠키를 자동 첨부합니다. 쿠키를 직접 읽거나 저장하지 않습니다. 백그라운드 범용 HTTP proxy는 없습니다.

허용되는 GET 목록 경로는 아래와 같습니다. 모듈의 인라인 항목이 누락되거나 일부만 있으면 module items API를 추가 조회합니다.

```text
/api/v1/courses?per_page=100&enrollment_state=active
/api/v1/courses/{내부에서 확인한 ID}/assignments?per_page=100&include[]=submission
/api/v1/planner/items?per_page=100[&start_date=YYYY-MM-DD&end_date=YYYY-MM-DD]
/api/v1/users/self/todo?per_page=100
/api/v1/courses/{ID}/modules?per_page=100&include[]=items&include[]=content_details
/api/v1/courses/{ID}/modules/{module ID}/items?per_page=100&include[]=content_details
```

각 페이지는 동일 출처·동일 경로만 허용합니다. 다음 과목/다른 API로 이동하는 링크, 알 수 없는 쿼리, 토큰 쿼리, 리다이렉트는 차단합니다. `page`는 양의 정수, `per_page`는 1–100으로 제한합니다. 알려지지 않은 opaque 페이지 파라미터가 오면 안전하게 중단합니다. 전체 20초/100페이지 예산에 과목명 해석도 포함하며, 각 목록 10,000건 제한입니다. 페이지 오류 때 부분 결과를 성공으로 표시하지 않습니다. 메시지는 23초 제한이고, content script는 같은 요청을 합치며 다른 동시 요청은 BUSY로 종료합니다. 패널에서 조회 중 메뉴를 바꾸면 진행 중 요청이 끝난 뒤 마지막으로 선택한 조회만 실행합니다.

Chrome 기능 권한은 `sidePanel`, `activeTab`, `scripting`, `downloads`입니다. 상시 호스트 권한은 두 LMS 호스트와 KU 플레이어(`kucom.korea.ac.kr`)입니다. 자막 감지를 위해 사용자가 강의 탭에서 도구 모음 아이콘을 눌렀을 때 `activeTab`으로 임시 접근하고 `scripting`으로 제한된 읽기 함수를 실행합니다. `cookies`, `storage`, `tabs`, 모든 사이트 접근 권한 및 상시 SSO 호스트 권한은 없습니다.

원본 응답은 처리 중 메모리에만 존재합니다. 메시지에는 필요한 공개 필드만 보내고 ID·URL·본문·첨부·토큰 등 나머지는 제거합니다. 텍스트 내 알려진 ID·URL·이메일·secret 패턴은 치환합니다. 범용 문자열 필터가 모든 임의 비밀을 판별할 수는 없으므로 로거는 정적 이벤트 코드만 받습니다. 오류 객체나 원본 응답은 출력하지 않습니다.

사용자가 명시적으로 다운로드한 자막 TXT·JSON을 제외하고 파일에 LMS 데이터를 저장하지 않습니다. Chrome storage, local/session storage, IndexedDB, telemetry도 사용하지 않습니다. Fetch는 `cache: no-store`입니다. 목록과 선택한 과목은 패널 메모리에 남아 탭 전환·페이지 탐색·새로고침에도 유지됩니다. 내 과목 목록은 메뉴로 돌아올 때 재사용하고 새로고침 버튼으로 갱신합니다. 다른 결과는 다음 조회·기능/필터 변경 때 교체하며, 로그인/권한 오류가 확인되면 보관한 과목 목록도 지웁니다. 패널 종료 시 메모리의 목록은 사라집니다. 브라우저 자체 네트워크 기록까지 제어하지는 않습니다.

과제 제출, 업로드, 글쓰기, 댓글, 수정, 삭제, 수강 변경, 영상 자동재생/keepalive/출석 자동화는 구현하지 않습니다. CLI의 자료 다운로드·일반 캘린더 이벤트·feed는 현재 범위 밖입니다.

## 녹화 강의 탐색과 탭 열기

**내 과목 → 녹화 보기** 또는 **녹화 강의 → 과목명 → 조회**로 탐색합니다. API 순서를 유지하며 모듈 이름과 제목을 표시합니다. Python과 같은 후보 규칙입니다.

- `ExternalTool`이면서 링크 메타데이터가 있는 항목. 외부 도구가 실제 영상인지 자동 판별하지 않으므로 ‘강의 후보’로 표시합니다.
- 교안·강의자료·자료 항목 제외.
- 모듈 및 항목의 미공개/잠김/미래 unlock/만료 lock 제외. `content_details`도 확인하고 해석할 수 없는 날짜는 제외합니다.
- `items`가 누락되거나 `items_count`보다 적으면 전체 module items 목록을 조회해 인라인 목록을 교체합니다. 모듈 추가 조회는 최대 3개씩 병렬 처리하고 결과는 원래 모듈·항목 순서대로 표시합니다. 모든 단계에서 Link 페이지네이션과 공유된 20초/100페이지 한도를 적용합니다. 하나라도 실패하면 나머지 요청을 중단하고 부분 목록을 반환하지 않습니다.

각 강의의 **LMS에서 보기**는 과목 모듈 화면, **LTI 탭 열기**는 Canvas module-item 경유 화면을 새 전경 탭으로 엽니다. 서비스가 제공하는 원본 LTI launch URL이나 `external_url`은 실행·전달·저장하지 않습니다. 실제 LTI 연결/리다이렉트/로그인은 열린 LMS 페이지가 처리합니다. module item ID가 없는 응답이면 개별 LTI 버튼을 비활성화하고 LMS 모듈에서 직접 열도록 안내합니다.

패널에는 URL/내부 ID 대신 무작위 UUID 선택 키를 보냅니다. content script의 메모리 목록은 5분 뒤, 다음 조회 때, 문서 종료 때 사라지며 키는 한 번 사용하면 폐기됩니다. 강의를 열어도 패널의 녹화 목록과 현재 목록 페이지는 유지하며, 사용한 열기 버튼만 비활성화합니다. 다음 강의도 목록을 조회했던 LMS 탭을 통해 열므로 플레이어가 활성 탭이어도 재조회할 필요가 없습니다. 원래 LMS 탭이 닫히거나 이동했으면 목록을 다시 조회해야 합니다. 알려진 lock 시각은 열기 직전에도 확인합니다. 목록 조회 뒤 서버에서 바뀐 권한/공개 상태 및 세션 유효성은 최종 LMS 화면이 검사하며 자동 재로그인은 없습니다.

녹화 강의의 제목·모듈명은 내부 ID와 숫자가 일치한다는 이유만으로 치환하지 않습니다. 날짜·차시 번호를 보존하며, URL·이메일·토큰 패턴·8자리 이상 숫자에 대한 공통 마스킹은 적용합니다.

백그라운드는 최상위 LMS content script의 발신자와 현재 탭 주소를 확인하고, 같은 출처의 `/courses/{ID}/modules` 또는 `/courses/{ID}/modules/items/{ID}` 주소만 엽니다. 임의 URL·쿼리·fragment·외부 호스트·API 주소는 차단합니다. `tabs.create`에는 추가 `tabs` 권한이 필요하지 않으므로 manifest 권한은 그대로입니다.

자동재생, 연속 재생, 숨겨진 탭, 영상 제어, 완료/출석 API, keepalive는 없습니다. 열린 LMS/LTI 자체가 영상을 재생하거나 시청·진도·출석을 기록할 수 있으며 재생은 사용자가 해당 화면에서 제어합니다. 정상 탭 탐색에 따른 **브라우저 방문 기록**까지 없애지는 않습니다. 확장은 원본 URL/응답을 콘솔·파일·확장 저장소에 기록하지 않습니다.

## 화면 자막 / 플레이어 VTT → TXT·JSON

1. 강의 페이지를 열고 도구 모음 **uniDock 아이콘**을 누릅니다.
2. **자막 추출 → 자막 감지**를 누릅니다.
3. **TXT·JSON 다운로드**를 누르면 브라우저 기본 다운로드 폴더의 `output/` 아래 두 파일을 저장 요청합니다. 저장 완료 여부는 브라우저 다운로드 목록에서 확인합니다.

먼저 접근 가능한 모든 프레임에서 `#cs-script-list > li.cs-script-item`의 `.cs-script-item-time`과 `.cs-script-item-text`를 읽습니다. 언어 속성을 요구하지 않습니다. 화면 목록이 하나라도 있으면 플레이어 파일을 요청하지 않습니다. DOM 목록이 부분 로드되어 있으면 그 범위만 저장됩니다.

목록이 없으면 `https://kucom.korea.ac.kr/em/` 프레임의 `window.uniPlayerConfig`에서 본편의 자막 XML 주소를 읽고, XML에서 한국어(`ko`, `kor`, `kr`, `ko-*`, Korean/한국어/한글/국문)를 우선 선택하여 VTT를 GET합니다. 한국어가 없으면 첫 자막을 사용합니다. KU 공개 플레이어 1.2.0.63 소스에 따라 `_contentPlayingInfoData.storyList`에서 첫 본편(`isIntro !== true`)을 선택하고 `storyFileNameList.caption`을 `contentUri` 기준으로 해석합니다. 정적 `captionUri` 및 remix의 `remixWebUri`도 지원합니다. XML의 `uri`는 플레이어와 동일한 콘텐츠 기준 경로로 해석합니다. 플레이어 함수는 실행하지 않고 데이터 속성만 읽습니다. 재생·탐색·출석 처리 함수는 호출하지 않습니다.

VTT가 없거나 유효하지 않으면 KU의 이미 로드된 `_mediaScriptList[].script`도 읽습니다. 일부 UPF 녹화 강의는 닫힌 자막 파일 없이 TXT 스크립트만 제공합니다. `[14:52:49 ~ 14:52:52]` 형식은 시작 시각과 문장으로 변환하며, 이는 영상 상대 시간이 아닌 녹화 시각일 수 있어 UI에 표시합니다. 한국어·영어가 같은 스크립트에 함께 있으면 원문을 보존합니다. 시간이 없는 TXT는 `time: ""`로 저장하고 임의의 시간을 만들지 않습니다. 이 단계에서는 추가 네트워크 요청이나 플레이어 함수 호출을 하지 않습니다.

VTT는 시작 시간을 보존하고 밀리초를 제거하며 한 cue의 여러 줄을 공백으로 합칩니다. 1시간 미만은 `MM:SS`, 이상은 `HH:MM:SS`입니다. 반복 대사는 유지하며 NOTE/STYLE/REGION과 cue ID는 제외합니다. TXT는 `00:36 문장` 형식이고 JSON은 다음 구조입니다.

```json
{
  "sourceUrl": "https://mylms.korea.ac.kr/lecture",
  "pageTitle": "강의 제목",
  "extractedAt": "2026-09-12T06:00:00.000Z",
  "itemCount": 1,
  "items": [{"index": 0, "time": "00:36", "text": "안녕하십니까?"}]
}
```

JSON에는 외부 강의 페이지의 URL과 제목을 담으며 플레이어 설정이나 자막 파일 URL은 포함하지 않습니다. 강의 URL의 쿼리도 원문대로 저장됩니다. 자막 문장에 있는 숫자·URL 등은 임의로 삭제하지 않습니다. 내보낸 파일은 사용자가 관리합니다.

KU iframe 접근을 위해 KU 호스트 권한, 다운로드 하위 폴더 지정을 위해 `downloads` 권한을 사용합니다. 외부 CDN은 페이지가 명시한 HTTPS XML/VTT만 요청하고 외부 출처로 인증 정보를 보내지 않습니다. CORS/CSP·접근권한으로 차단되면 우회하지 않습니다. HTML 오류 응답·잘못된 XML/VTT·리다이렉트·과도한 응답은 거부합니다.

파일당 1 MB fetch/100만 문자, DOM 20,000행, 결과 200만 문자, 프레임 20개 제한입니다. 플레이어 요청 전체 10초, 감지 전체 15초이며 자막은 패널 메모리에 최대 5분 보관합니다. 감지 도중 강의/iframe 문서가 바뀌면 결과를 폐기합니다. 추출한 자막은 대상 탭 이동·새로고침·닫기 또는 같은 창의 다른 탭 선택 시 초기화합니다. 무관한 탭 갱신이나 다른 창의 탭 선택으로는 초기화하지 않습니다. 자동 감지·자동 저장·영상 자동 재생은 하지 않습니다.

KU 소스 근거: [공개 교육 영상](https://kucom.korea.ac.kr/em/6746b8bd7574a), [플레이어 JavaScript](https://kucom.korea.ac.kr/viewer/uniplayer/uni-player.min.js?version=1.2.0.63)의 `getFirstStoryIdx`, `parseClosedCaption`, `ClosedCaptionParser`.

`npm run test:captions:live`는 공개 교육 영상의 XML/VTT에 실제 HTTP 요청을 보내 새 추출·변환·내보내기 함수를 검증하고 `output/ku-public-caption-test.txt`와 `.json`을 생성합니다. 공개 콘텐츠 XML로 단일 본편 설정을 구성하므로 로그인 세션, 실제 브라우저의 uniPlayerConfig, iframe 권한·CORS·다운로드 UI를 검증하는 테스트는 아닙니다.

## Python 계약 테스트

`tests/fixtures/python-contract.json`은 `../ku-lms-cli/tests/test_live_provider.py::FakeSession`의 **공개 가상 데이터**에서 생성했습니다. `scripts/generate_contract.py`는 지정된 공개 소스 두 파일만 읽습니다. AST로 fixture 리터럴과 공개 변환 함수/마감일 메서드만 추출해 실행하며, 참조 모듈을 import하거나 로그인/provider를 생성하지 않습니다. env·자격 증명·discovery 파일을 읽거나 참조 저장소에 쓰지 않습니다.

Python 녹화 후보 탐색 및 `_public_recording` 결과도 계약에 포함합니다. 확장은 추가로 임시 열기 키를 사용하며 Python의 `playable` 필드를 재생 기능으로 구현하지 않습니다.

Python `_public_assignment`, `_public_planner_item`, `_public_todo_item`, `_remaining_candidate`, `LiveLmsProvider.deadlines`의 결과를 기대값으로 고정합니다. 기준 시각은 `2026-09-11T00:00:00Z`이며 원본 파일 SHA-256도 기록합니다. 원본 fixture 외에도 누락/null 필드, 제출/채점/잠김, 과거/미래/경계 마감, UTC 기본값, 시차, 잘못된 날짜, 제목 fallback을 Python으로 계산한 사례를 포함합니다.

```sh
npm test                  # Node만 필요. golden JSON으로 전체 필드와 API 결과 계약 비교
npm run contract:check    # 선택적 개발 검증: Python 3.10+ 및 읽기 전용 참조 저장소 필요
npm run contract:refresh  # 참조 변경을 검토한 뒤 golden 갱신
```

`scripts/generate_caption_contract.py`는 공개 `captions.py`, `live.py`, `test_provider_cli_core.py`에서 단일/다국어 자막 fixture와 순수 변환 함수를 읽어 `tests/fixtures/python-captions.json`을 만듭니다. 한국어 선택과 TXT 결과도 Python과 비교합니다.

`contract:check`는 현재 Python 소스에서 재계산한 결과와 golden이 정확히 같은지 확인하고, 차이가 있으면 실패합니다. 참조 경로가 다르면 `python3 -B scripts/generate_contract.py --check /path/to/ku-lms-cli`로 실행할 수 있습니다. Python은 개발용 golden 생성에만 사용하며 확장 런타임/빌드에는 포함되지 않습니다. 일반 단위 테스트는 참조 저장소 없이 실행됩니다.

공개 정상 fixture 결과는 Python과 동일합니다. 민감정보가 텍스트에 섞인 응답은 확장의 더 엄격한 redaction을 적용하므로 의도적으로 원문과 다릅니다. 모든 Python 입력 타입/ISO 표기 변형에 대한 완전한 호환을 주장하지 않으며 Canvas의 ISO 날짜 형식을 지원합니다.

## 수동 LMS 검증

실제 로그인된 LMS 호출과 Chrome 114 실기기 검증은 아직 수행하지 않았습니다.

1. production 빌드를 로드하고 LMS 탭을 새로고침합니다. 로그인 전 조회 시 로그인/권한 안내를 확인합니다.
2. LMS에서 직접 로그인한 뒤 **내 과목 → 과제 보기**로 실제 과제명·마감·제출 상태를 LMS 화면과 비교합니다.
3. 같은 과목의 **마감일**에서 ‘남은 과제 후보만’을 해제한 뒤 과제 순서와 전체 행 수가 전체 과제 목록과 같은지 확인합니다. 제출/마감 완료된 행도 사라지지 않아야 합니다.
4. **Upcoming**에서 날짜 없이 조회한 뒤 시작일·종료일을 지정해 조회합니다. **Todo**의 할 일 제목·마감을 LMS와 비교합니다. 숨김/완료 버튼은 없어야 합니다.
5. 과목명 일부와 없는 과목명을 입력해 선택 오류를 확인합니다. 종료일이 시작일보다 빠르면 조회가 비활성화되어야 합니다.
6. 여러 페이지가 있으면 마지막 항목까지 표시되는지 확인합니다. LMS 로그아웃 후 다시 조회하면 기존 목록 대신 안내가 보여야 합니다. 동일 문서 내 로그아웃은 다음 조회 때 반영될 수 있습니다.
7. 일반 사이트 탭에서는 LMS 탭 안내, 네트워크 끊김에는 오류/시간 초과, 미갱신 탭에는 새로고침 안내를 확인합니다.
8. **녹화 강의**에서 모듈/제목을 LMS와 비교합니다. 교안·잠김 항목이 빠지는지, 목록 조회만으로 탭이 열리지 않는지 확인합니다. 각 열기 버튼은 선택한 항목의 탭 하나만 열어야 합니다. LTI 탭에서는 직접 재생을 제어합니다.
9. 목록을 5분 이상 둔 뒤 열기를 눌러 만료 안내를 확인하고 재조회합니다. 항목 ID가 없는 fixture에서는 개별 LTI 버튼이 비활성화되어야 합니다.
10. 한국어 자막이 있는 강의에서 도구 모음 아이콘 → 자막 감지를 실행합니다. DOM 우선 적용, VTT 한국어 우선 선택, TXT 시간 보존, JSON 메타데이터와 항목 일치, 재생 상태가 바뀌지 않는지 확인합니다. 영문만 있는 강의·자막 미로딩·cross-origin iframe에서도 오류 안내를 확인합니다.
11. 필요하면 DevTools에서 GET 메서드와 상태 코드만 육안 확인합니다. 원본 응답·헤더·쿠키·HAR·민감한 스크린샷을 저장/공유하지 않습니다. 확장 콘솔과 저장소에 LMS 데이터가 기록되지 않는지 확인합니다.

LMS가 iframe 내부에만 있으면 실제 최상위 LMS 탭을 열어야 합니다. 실 서비스 API/SSO 변화와 Chrome Web Store 심사는 별도 검증이 필요합니다.

## 공식 참고 자료

2026-09-11 확인. 패키지 정확한 버전은 `package.json`과 `package-lock.json`에 고정합니다.

- [Chrome scripting](https://developer.chrome.com/docs/extensions/reference/api/scripting), [activeTab](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab), [HTML track](https://developer.mozilla.org/en-US/docs/Web/API/HTMLTrackElement), [Blob object URL](https://developer.mozilla.org/en-US/docs/Web/API/URL/createObjectURL_static)
- [Chrome Side Panel](https://developer.chrome.com/docs/extensions/reference/api/sidePanel), [메시징](https://developer.chrome.com/docs/extensions/develop/concepts/messaging), [네트워크](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests), [Tabs 호스트 권한](https://developer.chrome.com/docs/extensions/reference/api/tabs)
- [WXT entrypoints](https://wxt.dev/guide/essentials/entrypoints.html), [manifest](https://wxt.dev/guide/essentials/config/manifest.html), [npm 공식 registry](https://registry.npmjs.org/)
- [Canvas Modules](https://developerdocs.instructure.com/services/canvas/resources/modules), [Canvas Assignments](https://developerdocs.instructure.com/services/canvas/resources/assignments), [Planner](https://developerdocs.instructure.com/services/canvas/resources/planner), [Users / Todo](https://developerdocs.instructure.com/services/canvas/resources/users), [Pagination](https://developerdocs.instructure.com/services/canvas/basics/file.pagination)

## 검증 결과

- `npm run check`: lint, typecheck, `npm test`, production build 통과.
- `npm run contract:check`: 현재 읽기 전용 Python 참조의 계산 결과 및 소스 해시와 일치.
- production manifest: `sidePanel`, `activeTab`, `scripting`, `downloads`와 `https://mylms.korea.ac.kr/*`, `https://canvas.korea.ac.kr/*`, `https://kucom.korea.ac.kr/*` 호스트 권한, Chrome 114 minimum 유지. `cookies`, `storage`, `tabs`와 기타 상시 외부 호스트 권한은 없음.
- 참조 저장소 `git status --porcelain`: 변경 없음.
- 실제 LMS 세션 요청 및 브라우저 UI 육안 검증: 미실시. 위 수동 절차로 확인 필요.


## Chrome Web Store 배포 준비

`npm run release`는 라이선스 고지를 갱신하고 `npm run check`(lint·typecheck·`npm test`·production build)와 의존성 감사를 실행한 뒤 Manifest/파일 allowlist/원격 실행 패턴을 검사합니다. 성공하면 `release/uniDock-0.1.0-chrome-mv3.zip`과 파일별 SHA-256을 담은 `release/inventory.json`을 생성합니다. ZIP은 배포 후보이며 자동 제출하지 않습니다.

- [보안 검토](documentation/SECURITY-REVIEW.md): 응답 크기 제한, 자막 시간 초과·GET 경로·getter 경계 보강 및 잔여 위험.
- [스토어 등록 문안](documentation/store/LISTING.md), [출시 체크리스트](documentation/store/RELEASE-CHECKLIST.md).
- [개인정보처리방침](public/privacy.html): 확장 내에서도 열 수 있으며 출시 전 공개 HTTPS 주소에 게시해야 합니다.
- `store/assets/`: 공개 fixture 기반 샘플 이미지 2개(1280×800), 작은 홍보 이미지(440×280). `npm run store:assets`로 재생성하며 로컬 Chrome이 필요합니다.

2026-09-11 배포 후보 검증: 전체 검사 통과, Python 계약 2종 일치, npm audit 알려진 취약점 0개, ZIP 허용 파일 12개 확인. 실제 계정 로그인·Chrome 114 및 최신 Chrome 통합 검증은 미실시입니다. 배포자 이름·지원 연락처·공개 정책 URL과 심사용 접근 방법을 확정한 후 체크리스트를 완료해야 합니다.

## 과거 기록: 2026-09-12 UI 및 성능 개선 검증

- 대상 탭의 문서 변경만 자막을 초기화하고, 무관한 탭 갱신에는 추출 결과를 유지합니다.
- 조회 중 메뉴 전환은 마지막 선택만 대기시켜 자동 실행합니다. 녹화 열기는 목록·페이지를 유지하고 원래 LMS 탭을 통해 처리합니다.
- 날짜 포매터를 재사용하고 목록을 100개씩 표시합니다. 모듈 추가 조회는 최대 3개 병렬 처리하며 순서·공유 예산·실패 시 전체 중단을 검증했습니다.
- `npm run check`: 13개 파일의 231개 테스트, lint, 타입 검사, production build 통과. `npm run contract:check`, `npm run format:check` 통과.
- UI 상호작용은 Chrome API mock 기반 jsdom 테스트로 검증했습니다. 실제 로그인 세션과 확장 권한을 포함한 Chrome 통합 검증은 별도로 필요합니다.

## 개인정보처리방침 GitHub Pages 배포

`docs/`는 공개 사이트 전용입니다. 개발·보안 검토·스토어 준비 문서는 `documentation/`에 보관합니다. 이 구분은 Pages 배포 범위만 제한하며, 공개 저장소의 문서를 비공개로 만들지는 않습니다.

개인정보처리방침은 `public/privacy.html`을 수정한 뒤 다음 명령으로 배포용 사본을 갱신합니다.

```sh
npm run pages:sync
npm run pages:check
```

`docs/privacy.html`과 `docs/index.html`에 같은 방침을 복사하므로 사이트 첫 화면과 `/privacy.html`에서 모두 읽을 수 있습니다. 생성된 HTML은 직접 수정하지 않습니다. CI와 `npm run check`에서 원본과 두 사본이 일치하는지 검사합니다. `docs/.nojekyll`은 정적 파일을 그대로 게시하도록 유지합니다.

1. 원본과 갱신된 `docs/` 파일을 함께 커밋하고 `main`에 푸시합니다.
2. GitHub 저장소 **Settings → Pages → Build and deployment**에서 **Deploy from a branch**, **main**, **/docs**를 선택하고 저장합니다.
3. 배포 완료 후 Pages에 표시된 사이트 주소에 `/privacy.html`을 붙여 비로그인 상태에서 접근을 확인하고, Chrome Web Store 개인정보처리방침 URL로 등록합니다.

설정 방법: [GitHub Pages 배포 소스 공식 문서](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site).
