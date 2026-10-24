# uniDock 0.1.0 보안 검토 — 2026-09-11

상태: **코드 수정 및 배포 후보 준비. 실제 LMS/Chrome 114/스토어 심사 검증은 남아 있음.** 독립 침투시험이나 보안 인증이 아니며 무결함 보장을 의미하지 않습니다.

## 범위와 방법

모든 src/entrypoints, Manifest, 빌드 설정, 패키지/lockfile, 메시지 흐름, 입력/출력 투영, API·페이지네이션, 탭 열기, 자막 DOM/MAIN 경계, 다운로드, 로깅·보관, 공급망과 최종 ZIP을 검토했습니다. 단위·계약·회귀 테스트 및 npm audit를 수행합니다. 참조 ku-lms-cli는 읽기 전용이며 env/비공개 discovery/사용자 세션은 조사하지 않았습니다.

보호 대상은 인증 세션, 내부 LMS ID, URL/LTI 파라미터, 과제·제출 상태, 자막 및 사용자 탭입니다. LMS 응답/Link, 페이지 DOM, MAIN world 값, extension 메시지는 신뢰하지 않습니다. LMS 서버와 브라우저 자체가 침해되지 않았다는 가정은 남습니다.

## 발견 및 수정

| ID     | 심각도    | 문제                                                                        | 조치                                                                                                             |
| ------ | --------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| SEC-01 | 중간      | API JSON을 크기 제한 없이 읽어 메모리 고갈 가능                             | 스트림을 읽으며 페이지당 2 MB에서 취소, Content-Length도 사전 검사. 전체 20초/100페이지·목록 10,000개 제한 유지  |
| SEC-02 | 중간      | 자막 대기 시간 초과 후 늦게 끝난 DOM 작업이 MAIN 읽기를 계속할 수 있음      | 시간 초과 플래그 검사로 후속 주입·처리를 막음. 이미 주입된 작업의 강제 종료를 보장하지는 않음                    |
| SEC-03 | 중간      | 선언된 track src가 동일 출처 임의 GET endpoint일 수 있음                    | 자막 확장자 vtt/srt/ttml/dfxp/smi 경로로 제한하고 명백한 변경/로그아웃 경로 차단. 외부 출처·리다이렉트 계속 금지 |
| SEC-04 | 중간      | MAIN의 중첩 caption getter를 실행할 수 있음                                 | own data descriptor로 배열 원소·label/lang/caption/cues/text를 읽어 일반 accessor 실행 방지                      |
| SEC-05 | 배포 요건 | 로컬 데이터 처리 고지·개인정보 페이지·비공식 표시·아이콘·패키지 검사가 부족 | UI 고지, bundled privacy, 배포 문서, 자체 아이콘, 제한적인 ZIP allowlist·해시 검사 추가                          |

각 코드 조치는 tests/security-review.test.ts에서 회귀 검증합니다. 기존 자막/메시지/호스트/GET/페이지네이션/만료 및 Python 계약 테스트도 유지합니다.

## 확인한 경계

- API 클라이언트는 내부에서 만든 GET 목록 endpoint만 허용하며 URL/메서드 프록시가 없습니다. 각 next Link는 동일 출처·동일 경로·허용 query만 통과합니다.
- content script는 확장 자신의 Side Panel 발신자만 처리합니다. 백그라운드 탭 열기는 확장 ID, 최상위 LMS 프레임, 현재 탭 URL, canonical LMS 경로를 검사합니다. 외부 메시징/웹 접근 리소스는 선언하지 않습니다.
- 원본 API 객체 대신 공개 필드만 전달합니다. React 텍스트 렌더링이며 innerHTML/eval/동적 원격 코드가 없습니다. extension CSP는 self 스크립트, object/connect/base/form 금지를 적용합니다. content script의 동일 출처 Fetch는 별도 실행 경계입니다.
- credential 입력 없음. 쿠키 값 읽기는 LearningX 게시판 토큰(`xn_api_token`) 하나로 한정합니다(아래 "LearningX 게시판" 참고). 정적 이벤트 코드 로깅 하나만 존재. 명시적 TXT 내보내기 이외 지속 저장 없음.
- activeTab은 사용자가 아이콘을 누른 탭의 임시 권한입니다. 상시 호스트 권한은 두 LMS 출처뿐입니다. MAIN에서 읽은 값은 기능/코드로 실행하지 않고 다시 검증합니다.
- 자동재생/seek/keepalive/출석/제출·수정 기능 없음. 사용자가 연 LMS/LTI 자체의 동작은 별개입니다.
- production ZIP에는 runtime JS/CSS/HTML, 아이콘, 개인정보 페이지, 제3자 라이선스만 포함합니다. 소스·테스트·Python·env·개발 서버·source map·스토어 자료는 제외합니다.

## 남은 위험·출시 전 검증

1. 실제 LMS/SSO/LTI/자막 서버 및 Chrome 114에서 아직 검증하지 않았습니다. 원격 로그인 유효성·수업 자료 변화·현재 학기 응답 형식을 fixture로 증명할 수 없습니다.
2. MAIN world는 페이지가 전역 내장 함수까지 변조하거나 Proxy trap을 둘 수 있습니다. 일반 getter는 막지만 적대적인 페이지를 완전히 격리하지 못합니다. script 실행이 동기적으로 멈추면 패널 15초 timeout이 그 코드를 강제 종료하지 못합니다. 알려진 강의 탭에서만 사용해야 합니다.
3. 민감정보 정규식은 완전한 DLP가 아닙니다. 오탐·미탐 가능성이 있으며 로그인/계정 데이터가 아닌 공식 자료를 대상으로 사용합니다. 자막의 정확성·전체 분량·저작권 허용은 LMS와 사용자에게 달려 있습니다.
4. 캐시된 availability는 서버의 즉각적인 권한 변경을 보장하지 않습니다. 최종 LMS가 권한을 집행합니다. 같은 문서에서 로그인 사용자가 바뀌면 다음 조회 전까지 이전 화면이 남을 수 있습니다.
5. 정상 LMS/LTI 탐색의 브라우저 방문 기록·서버 접근/시청 기록, 사용자가 저장한 암호화되지 않은 TXT 파일은 확장이 삭제하지 않습니다.
6. 정적 npm audit 결과 0개는 알려진 advisory 기준이며 공급망 안전 보장이 아닙니다. lockfile 고정, npm ci, 재배포마다 audit 및 ZIP 해시 확인이 필요합니다.

발견한 수정 대상은 처리했습니다. 위 잔여 위험과 계정/공개 정책 URL/실기기 검증 때문에 이 산출물을 ‘심사 승인’ 또는 ‘배포 완료’로 표현하지 않습니다.

## 2026-09-12 자막 경로 변경

위 검토는 이전 TXT 전용 구현에 대한 기록입니다. 현재 자막 구현의 경계는 다음과 같이 변경되었습니다.

- DOM 시간/문장 우선, KU 설정의 XML → 한국어 우선 VTT 대체 조회. 플레이어 데이터만 읽으며 재생/탐색/출석 API는 호출하지 않습니다.
- KU 호스트와 downloads 권한 추가. JSON에는 사용자가 요청한 강의 URL(쿼리 포함), 제목, 추출 시각 및 자막 항목을 저장합니다. 기존 자막 민감 패턴 제거 정책은 적용하지 않습니다.
- 외부 자막 서버는 선언된 HTTPS XML/VTT만 요청하고 credentials를 omit합니다. CORS/CSP를 우회하거나 리다이렉트를 따라가지 않습니다. XML DTD/entity와 파싱 오류, 잘못된 VTT는 거부합니다.
- 새 경로 회귀 테스트는 tests/captions.test.ts, 과거 Python 변환 계약은 tests/captions-legacy-contract.test.ts에 있습니다. KU 공개 플레이어 1.2.0.63 소스의 본편 선택 및 XML/VTT 경로 해석을 확인했습니다. 공개 영상 HTTP smoke test와 별개로 로그인된 강의의 확장 UI/권한/CORS 통합 검증은 남아 있습니다.

- UPF TXT 스크립트 대체 경로: 이미 로드된 `_mediaScriptList`의 데이터 속성만 읽으며 네트워크 요청이나 플레이어 함수는 실행하지 않습니다. 녹화 시각을 재생 위치로 추정하지 않고 원문 시각을 보존합니다. 시간 없는 스크립트는 빈 time으로 명시합니다.

## 2026-09-30 0.1.1 배포 범위: 자동 재생 제외

아래 2026-09-26 순차 자동 재생 검토는 저장소 구현에 대한 기록입니다. 기능이 검토 중이므로 0.1.1 배포 빌드에서는 빌드 타임 상수 `__UNIDOCK_PLAYBACK__`(기본 `false`, `UNIDOCK_PLAYBACK=1`일 때만 `true`)로 코드를 제외합니다.

- 제외 항목: `player` 콘텐츠 스크립트(LMS·KU 플레이어 전 프레임 주입), background 재생 런타임·alarm·탭 소유권 처리, LMS content script의 `PLAYBACK_DISCOVER`/`PLAYBACK_RESOLVE_BATCH` 처리, 사이드패널 재생 화면.
- 권한 축소: `storage`, `alarms` 제거. 배포 manifest 권한은 `sidePanel`, `activeTab`, `scripting`, `downloads`와 기존 세 호스트입니다. `kucom.korea.ac.kr`은 자막 읽기에 계속 필요합니다.
- 저장소: 배포 빌드는 `chrome.storage`·IndexedDB·Web Storage를 사용하지 않습니다. 아래 “저장소 경계”는 재생 빌드에만 해당합니다.
- UI: 메뉴의 `자동 재생`은 `aria-disabled` 버튼과 “현재 검토 중인 기능입니다.” 툴팁만 남고 메시지를 보내지 않습니다.
- 강제 장치: `scripts/package-release.mjs`가 `UNIDOCK_PLAYBACK=1` 환경, `player.js`, `storage`·`alarms`, 설명의 “자동 재생”, 재생 전용 문자열(`unidock.playback.owned-tab`, `PLAYBACK_PLAYER_HELLO`, `PLAYBACK_DISCOVER`, `PLAYBACK_REFRESH`, `unidock-playback-v1`)을 발견하면 패키징을 중단합니다. 번들에 남는 `playback` 문자열은 React DOM 내장 속성명, 도달 불가능한 내비게이션 enum, 메뉴 라벨·아이콘뿐입니다.
- 검증: 제외 빌드 E2E(재생 전용 spec skip)와 `npm run test:e2e:playback` 전체 E2E를 모두 합성 LMS에서 통과했습니다. 실제 LMS·Chrome 114 검증 범위는 변하지 않았습니다.

## 2026-09-26 opt-in 순차 자동 재생

위 검토 및 자막 경로 변경은 이전 구현에 대한 기록입니다. 순차 자동 재생은 과목을 고른 뒤 사용자가 영상을 직접 체크하고 시작하는 opt-in이며 기본 비활성입니다. 이 추가분은 자동 재생의 보안 경계를 기술합니다.

### 추가 권한

| 권한      | 용도                                                                                                                                           |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage` | 계정별 최소 재생목록 상태는 `chrome.storage.local`, 전용 탭 소유권은 `chrome.storage.session`에서 확인합니다. 동기화 저장은 사용하지 않습니다. |
| `alarms`  | 진행 중인 재생의 제한된 lease/watchdog 만료를 확인합니다. 예약 시작에는 사용하지 않습니다.                                                     |

### 순차 자동 재생

사용자가 체크한 녹화 강의만 체크 순서대로 즉시 1x(정상) 속도로 재생합니다. 네이티브 `ended`가 확인될 때만 다음 영상으로 전환합니다. 마감·길이·완료 상태를 추정하거나 시간대별 예약을 만들지 않습니다.

- 1x 고정: `playbackRate = 1`만 사용합니다. 배속 재생이나 속도 조작은 하지 않습니다.
- 사용자 활성 탭 필요: 브라우저가 실행 중이고 전용 강의 탭이 활성 상태여야 합니다. 숨겨진 탭이나 백그라운드에서 재생하지 않습니다.
- "ended"와 "LMS 출석"의 구분: 플레이어는 브라우저의 네이티브 `ended` 이벤트로 영상 종료를 감지합니다. 이는 LMS의 시청 완료/출석 인정과 별개입니다. 인정 상태 출처가 확인되지 않으면 `unknown`으로 두며 출석을 위조하거나 LMS 완료/출석 API를 호출하지 않습니다.
- LMS 재검증: 시작·영상 전환·재생 중 lease 갱신 때 현재 계정과 강의 접근 권한을 다시 확인합니다. 로그인이 풀리면 재생목록은 보존하되 재생을 중단하고, 사용자가 다시 로그인한 뒤 명시적으로 재개해야 합니다. 상태 조회와 새로고침은 암묵적으로 재개하지 않습니다.
- 재생목록 저장: `chrome.storage.local`에 계정별 최소 과목/항목 식별자, 순서와 전용 탭 복구 포인터를 저장합니다. 임시 탭 소유권은 `chrome.storage.session`으로 확인합니다. 일회성 handle, 라벨, 강의 URL, LTI launch URL, 서명된 LTI 파라미터, 쿠키, 토큰은 저장하지 않습니다. 이전 예약 스키마는 즉시 재생으로 변환하지 않고 폐기합니다.

### 2026-09-26 수업 자료 다운로드 경계

모듈의 접근 가능한 PDF `File` 항목만 투영하고, 파일 ID는 `internalId(content_id)`에서만 얻습니다. `url`·`html_url`·서명 주소에서 추출하지 않습니다. 파일 ID가 없으면 LMS 열기만 제공합니다. 목록은 최대 10,000건, hydration 동시성 3, 공유 시간·페이지 예산 및 실패 시 전체 실패를 유지합니다.

- 패널 → content script: 닫힌 `DOCUMENT_DOWNLOAD` 메시지는 version/type/handle/course 4개만 받습니다. 다운로드 handle은 열기 handle과 종류를 분리한 5분·일회용 capability이며 사용 시 모듈·항목 접근성을 다시 검사합니다. 여러 파일은 원래 탭을 고정해 순차 요청하고 목록 이동 시 미전송 항목을 취소합니다.
- content script → background: `DOWNLOAD_LMS_FILE`은 version/type/url/filename 4개만 받습니다. 자기 확장 ID, frame 0, 탭 ID와 발신 URL, 현재 탭 URL 일치를 검사합니다. 같은 출처의 `/courses/[1-9]\\d{0,19}/files/[1-9]\\d{0,19}/download?download_frd=1`만 허용합니다. userinfo, hash, 비정규 표기, 추가·중복·누락 쿼리, 교차 LMS 출처, 300자 초과 URL은 거부합니다.
- filename은 redaction과 구분자·제어문자 정리 후 `uniDock/<과목>/<모듈>/<제목>.pdf`로 만들고 background가 다시 검증합니다. 세그먼트 최대 80자, 전체 240자, 절대경로·역슬래시·빈/점 세그먼트·금지 문자를 거부합니다. 경로가 너무 길면 실패하며 임의 위치에 저장하지 않습니다.
- background는 `chrome.downloads.download`에 `conflictAction:uniquify`, `saveAs:false`를 지정합니다. 결과에는 다운로드 ID나 URL을 돌려주지 않습니다. 실패는 정적 코드로만 기록합니다.
- 패널은 요청 전에 onCreated/onChanged를 구독합니다. 확장 자신의 다운로드, 원본 LMS 정규 URL, 유일하게 일치하는 경로만 연결하고 개별 이벤트 ID로 상태를 조회합니다. 전체 다운로드 기록이나 filenameRegex 검색은 하지 않습니다. 불확실한 연결은 요청됨으로 남습니다. MIME이 PDF가 아니면 확인 필요를 표시합니다.

위협 모델: 위조 메시지, raw URL 주입, 교차 출처/쿼리 우회, 경로 순회, capability 재사용·교차 사용·만료 및 탭 이동을 차단합니다. 브라우저 다운로드는 LMS 리다이렉트를 따라갈 수 있어 서버가 반환한 로그인 HTML이나 잘못된 PDF를 완전히 예방하지는 못합니다. MIME 검사는 경고일 뿐 내용 검증이 아니며 파일은 삭제하지 않습니다. 서버 권한 변경은 최종 LMS가 집행합니다.

로컬 PDF 파서·worker·LanguageModel 및 해당 의존성을 제거했습니다. 확장은 PDF를 fetch·파싱·업로드하지 않습니다. ChatGPT 동작은 템플릿 복사와 고정 시작 페이지 열기뿐이며 첨부·제출은 사용자가 수행합니다. 권한과 host_permissions는 추가하지 않고 CSP worker-src도 제거합니다.

### 저장소 경계

- `chrome.storage.local`에 계정별 설정·최소 메타데이터를 보관하고, 재생 탭 소유권 확인에는 `chrome.storage.session`을 사용합니다. `sync`, `managed`는 사용하지 않습니다.
- 저장 데이터: 자동 재생목록의 과목/항목 최소 식별자·순서·상태. 계정 키는 출처, 확인된 사용자 ID와 설치별 무작위 salt를 해시하여 만듭니다.
- 보관 기간: 활성 또는 중단된 재생목록은 완료·중지·사용자 삭제 전까지 유지됩니다.
- 사용자 삭제: 사용자는 패널에서 계정별 재생 상태를 즉시 삭제할 수 있습니다.
- 미저장 항목: 쿠키/토큰 값, 원본 API 응답 전체, 서명된 LTI URL, 플레이어 설정, 자막 파일, 오류 객체. 실행 시 재검증에 필요한 최소 과목/항목 ID만 예외적으로 저장합니다.

### 변경되지 않는 경계

- LMS 데이터의 외부 AI API·개발자 서버·분석 서비스 자동 전송 없음. 0.1.2부터 별도 동의한 최소 사용 통계만 아래 경계로 전송합니다. 사용자가 외부 사이트에 직접 제출한 자료는 해당 서비스 경계에 속함.
- `cookies`, `tabs`(광범위), `debugger`, 모든 사이트 접근 권한 미요청.
- 출석 위조와 LMS 완료/출석 API 호출 없음. 진행 중인 영상에서만 종료 기한이 있는 짧은 플레이어 권한 갱신을 허용하며 무한 keepalive는 사용하지 않음.
- 자막, 조회 결과, 메시지의 기존 보안 경계(redaction, 공개 필드 투영, 크기 제한, 시간 제한)는 그대로 유지.

### 남은 검증

1. 계정별 저장·명시적 시작·순차 전환·로그인 중단/재개·탭/worker 복구는 합성 fixture 및 상태 머신 테스트로 검증합니다. 실제 LMS 계정에서의 동작은 별도 검증이 필요합니다.
2. 영상별 출석 인정 기한·길이·완료와 LMS credit 조회 경로는 실제 배포본에서 검증되지 않았습니다. 이를 자동 재생 순서나 완료 표시에 사용하지 않습니다.
3. 실제 LMS/SSO/LTI 플레이어, Chrome 114, 출석 인정 및 다중 실제 과목 시나리오는 검증하지 않았습니다. 선택한 검증 강의에서만 시청 기록에 영향을 주는 점검을 수행해야 합니다.

## 2026-09-30 선택적 PostHog 사용 통계 (0.1.2)

위의 telemetry 없음/connect 금지 기술은 과거 버전 기록입니다. 이번 변경의 경계:

- 기본 비활성. 명시적 동의 전 분석 식별자 생성·SDK 초기화·통신 없음. 거절도 ID 없이 선택만 로컬 저장. 기능 사용은 동의에 종속되지 않음.
- `src/analytics/contract.ts`의 닫힌 이벤트/속성 계약을 background에서 재검증. 패널 URL/확장 ID를 검증하고 content script 발신자는 거부. 임의 이벤트명·속성·URL·오류·계정 식별자를 전달할 수 없음.
- UI의 정적 `data-analytics-action`만 사용. DOM 텍스트·입력값·페이지 주소를 읽지 않음. 학습 요청·응답은 분석 모듈로 전달하지 않고 명시적 기능 이름과 성공/실패만 보냄.
- `@posthog/core` stateless SDK를 패키지에 번들. DOM 자동 수집·리플레이·히트맵·서베이·원격 설정을 초기화하지 않음. 전송 어댑터는 EU ingestion의 정확한 `/batch/` POST만 허용. 별도 호스트 권한 추가 없음, CSP `connect-src`에 `https://eu.i.posthog.com` 하나 추가.
- credential omit, referrer 없음, redirect error, 5초 timeout. 요청 최대 8KB, 동시 4개·분당 120개 한도. SDK 자동 재시도/주기 큐를 사용하지 않으며 이벤트는 디스크에 저장하지 않음. 장애 시 학습 기능과 독립적으로 버림.
- 동의 상태와 무작위 UUID만 trusted-context 로컬 저장소에 저장. LMS salt/계정키를 재사용하지 않음. 작업 시작 당시 동의 ID로 결과 이벤트를 제한하고 background에서도 최신 동의 ID 확인.
- 철회/전체 삭제 시 즉시 세대 무효화·진행 중 요청 abort 및 식별자 제거. 이미 수신된 통계를 되돌릴 수 없으므로 UI/정책에 명시. 재동의는 새 식별자. 여러 패널은 storage 변경으로 동기화.
- 활성 시간은 단조 시계, 가시성·포커스·60초 유휴 기준. 10초 넘는 타이머 공백은 제외. 종료/오프라인 손실이 있어 정확한 인원/시청 시간으로 해석하지 않음.
- SDK GeoIP 비활성 및 `$ip: null`, person profile 처리 비활성. HTTP 연결 IP/브라우저 헤더는 수신 서버가 볼 수 있으므로 완전 익명이라고 주장하지 않음. 운영 프로젝트의 IP 폐기·최대 90일 보관과 원격 삭제 절차는 배포자 설정 필요.

검증 범위와 실제 프로젝트 연결 절차는 [ANALYTICS.md](ANALYTICS.md)를 참조합니다. 운영 토큰·보관 설정·스토어 게시·라이브 수신은 코드 변경만으로 완료되지 않습니다.

## 2026-10-04 자료 확장·분석 통합·업데이트 안내

- 자료 후보 형식은 PDF/PPTX/PPT입니다. 모듈 `content_details.display_name`과 게시판 첨부 메타데이터의 파일명을 사용하며, 서명 URL에서 형식·ID를 추출하지 않습니다. 파일 내용은 읽지 않습니다.
- `GET /api/v1/courses/:cid/discussion_topics`와 고정 `only_announcements=true`를 읽기 허용 목록에 추가했습니다. 기존 페이지·시간·응답 크기 예산을 공유합니다. 보조 출처인 게시판·공지의 첫 페이지가 401/403/404이면 해당 출처만 비어 있는 것으로 처리하고, 리다이렉트·이후 페이지 실패·기타 오류는 부분 결과를 공개하지 않습니다. 열기 경로는 같은 과목의 정규 `discussion_topics/:id`로 제한합니다.
- LearningX 게시판(과목 메뉴의 외부 도구 게시판): `GET /learningx/api/v1/learningx_board/courses/:cid/boards`, `.../boards/:bid/posts?page=N`, `.../boards/:bid/posts/:pid`만 허용합니다. 이 API는 세션 쿠키가 아니라 `Authorization: Bearer`를 요구하므로, content script가 요청 순간 `document.cookie`에서 `xn_api_token`(JWT 형식·4KB 이하·단일 값만)을 읽어 이 세 경로에만 붙입니다. `cookies` 권한은 쓰지 않으며 토큰은 저장·로그·메시지·캐시에 남기지 않습니다. 첨부의 `canvas_file_id`만 사용해 기존 Canvas `/courses/:cid/files/:id/download?download_frd=1` 경로로 받습니다. LearningX의 다운로드 URL·`post_url` 원문은 사용하지 않고, `post_url`에서 같은 과목의 도구 ID만 추출해 `/courses/:cid/external_tools/:tid`를 엽니다. 별도 300요청 예산이 있으며, 토큰이 없거나 첫 게시판 목록이 401/403/404이면 이 출처만 건너뜁니다. 이후 실패는 계정 범위 초기화 없이 NETWORK 전체 실패로 처리합니다. 실측 결과 게시글 상세 GET은 조회수를 바꾸지 않았습니다(2026-10-04, 1개 과목). 토큰은 LMS에서 LearningX 게시판을 열 때 발급되고 약 4시간 유효하므로, 그 밖의 경우 게시판 자료는 표시되지 않습니다.
- 다운로드는 기존 canonical 파일 경로·일회용 핸들·background 재검증을 유지하며 파일명 확장자와 MIME을 형식별로 확인합니다.
- 기본 빌드에 분석용 `storage`를 추가하고 `alarms`·자동 재생 제외를 유지했습니다. 정보 화면의 로컬 삭제는 분석 요청 중단 후 저장소를 삭제합니다.
- 운영 토큰의 실제 SDK 요청을 합성 프로필에서 전송해 EU `/batch/` HTTP 200을 확인했습니다. 90일 보관·원격 삭제 설정 검증과는 별개입니다.
- 업데이트는 탭을 자동으로 열지 않습니다. Chrome의 실제 버전 증가 이벤트에만 아이콘 `NEW` 배지를 달고, 패널 출처(`sidepanel.html`)에서 온 정확한 `UPDATE_NOTICE_TAKE` 메시지만 배지를 소비합니다. 사이드 패널 대체용 `!` 배지는 덮어쓰거나 지우지 않습니다. 외부 조회·버전 저장·식별자 생성은 없습니다.
- 설치·업데이트(`reason`이 `install`/`update`) 직후 `tabs.query`를 두 LMS 호스트 패턴으로만 호출하고, `allowedPage`를 통과한 탭에 패키지 파일 `content-scripts/lms.js`만 최상위 프레임에 주입합니다. 문자열 코드·함수 인자·다른 호스트 주입은 없고, 새 권한도 필요하지 않습니다(`scripting` + 기존 호스트 권한). 업데이트로 연결이 끊긴 기존 인스턴스는 메시지를 받지 못하며 페이지 수준 공유 상태가 없어 새 인스턴스와 충돌하지 않습니다.

### 2026-10-01 문서 재검토 (이전 기록)

로컬 `.env.local` 토큰의 빌드 반영은 확인했고, 실제 PostHog 수신은 사용자가 확인했습니다. 기존의 미연결 표기는 2026-09-30 검증 당시 기록입니다. 운영 프로젝트의 IP 폐기·최대 90일 보관·설치 ID별 원격 삭제는 아직 확인하지 않았습니다. 특히 공개 정책의 90일 보관 약속을 확장 코드가 집행하지 않으므로 실제 서버 설정/삭제 운영과의 일치 확인이 남아 있습니다. 대시보드 생성·최종 ZIP 재생성·스토어/공개 정책 게시도 별도 항목으로 관리합니다.

## 2026-10-20 opt-in LMS 팝업 자동 닫기

구현 중인 기능의 배포 계약과 보안 경계를 문서화합니다. 아래 내용은 실제 LMS 동작 검증이나 출시 완료를 의미하지 않습니다.

- 진입점 `entrypoints/lms-popup.content.ts`는 `content-scripts/lms-popup.js`로 번들됩니다. 사용자가 확인한 공지 포털 `https://lms.korea.ac.kr/*`에만 주입하며 `allFrames: false`, `runAt: document_idle`로 최상위 프레임에서 실행합니다(스크립트도 최상위·포털 origin이 아니면 바로 종료). 2026-10-23부터 이 호스트는 상시 `host_permissions`가 아니라 `optional_host_permissions`이고, 스크립트는 manifest에 선언하지 않는 런타임 등록(`registration: "runtime"`)입니다. 따라서 기능을 켜지 않은 사용자에게는 설치·업데이트 시 새 권한 경고나 재승인이 없습니다. 기존 `LMS_MATCHES`, Canvas GET API 허용 목록, 기능 권한(`scripting`은 기존 권한)과 CSP는 변경하지 않습니다.
- 켜기: 패널이 클릭 안에서 `chrome.permissions.request({origins: ["https://lms.korea.ac.kr/*"]})`를 먼저 호출하고, 허용된 경우에만 boolean을 저장합니다. 거절하면 저장하지 않고 꺼짐으로 남습니다. 백그라운드는 boolean과 권한이 모두 있을 때만 `scripting.registerContentScripts`로 `content-scripts/lms-popup.js`를 등록하고(고정 ID `unidock-lms-popup`, 위와 같은 matches·최상위·`document_idle`), 이미 열린 포털 탭 최상위 프레임에 같은 패키지 파일을 `executeScript`로 넣습니다. 같은 문서에 다시 들어간 스크립트는 WXT 컨텍스트가 이전 인스턴스를 무효화하므로 관찰자는 하나만 남습니다.
- 끄기·로컬 데이터 삭제: 끄기는 패널이 `false`를 먼저 저장하고(워커가 열린 포털 탭에 무효화 신호를 보내고 등록 해제) 그다음 `permissions.remove`로 권한을 반납합니다. 로컬 데이터 삭제는 워커가 저장소를 지운 뒤 권한을 반납하고 응답합니다. 사용자가 `chrome://extensions`에서 권한을 거두면(`permissions.onRemoved`) boolean을 지워 꺼짐으로 맞춥니다. 워커는 시작할 때마다 등록 상태를 boolean·권한과 맞추며, 권한 없이 남은 boolean은 두 번 읽어 확인한 뒤 지웁니다.
- 순서: 권한 요청·반납은 패널(그리고 패널이 기다리는 삭제 명령)에서만 일어납니다. 스위치와 로컬 데이터 삭제는 패널 안에서 한 번에 하나만 실행되며(요청은 클릭의 사용자 제스처 안에서 시작해야 하므로 대기열 대신 실행 중에는 거부하고 컨트롤을 비활성으로 표시) 켜기는 요청 후 저장, 끄기는 저장 후 반납 순서입니다. 워커의 변경 작업은 순서대로 실행되고 매번 현재 boolean·권한을 다시 읽어 등록만 맞추며 권한은 바꾸지 않습니다. 이전 구현은 워커가 끄기 작업 끝에 권한을 반납해, 빠른 끄기→켜기에서 켜기 요청이 아직 남은 권한으로 즉시 통과한 뒤 늦은 반납이 새 권한과 켜짐 설정까지 지웠습니다(소스 함수·모의 Chrome API로 재현, 회귀 테스트 `tests/background.test.ts`, `tests/popup-settings-ui.test.tsx`). 사이드 패널을 여러 창에 동시에 열고 각각 조작하는 경우의 순서는 보장하지 않습니다.
- 정보 화면의 명시적 opt-in만 허용합니다. `chrome.storage.local`의 `unidock.popup-auto-close.v1` boolean이 없거나 유효하지 않으면 `false`입니다. 로컬 데이터 모두 삭제는 이 키도 제거해 비활성으로 되돌립니다. 팝업 내용·식별자나 페이지 콘텐츠는 저장하지 않습니다.
- `storage.local`은 워커 부팅마다 `TRUSTED_CONTEXTS`로 잠그므로 콘텐츠 스크립트는 저장소를 읽거나 `storage.onChanged`를 받지 않습니다. 사이드 패널(신뢰 컨텍스트)이 키를 직접 쓰고, 콘텐츠 스크립트는 닫힌 메시지 `{version: 1, type: "POPUP_AUTO_CLOSE_GET"}`로 백그라운드에 묻습니다. 백그라운드는 발신자가 이 확장 ID, `frameId: 0`, 탭 ID 보유, URL·origin이 정확히 `https://lms.korea.ac.kr`(사용자 정보 없음)일 때만 `{version: 1, type: "POPUP_AUTO_CLOSE_STATE", enabled: boolean}`을 응답하고, 그 밖에는 `{ok: false}`를 반환하며 저장소를 읽지 않습니다. 콘텐츠 스크립트는 필드 수까지 정확한 응답만 받아들이고 거부·오류·형식 오류는 비활성으로 처리해 관찰을 멈춥니다(fail closed).
- 백그라운드의 `storage.onChanged`는 `local` 영역에서 이 키가 바뀔 때만(쓰기·`remove`·`clear` 포함) 선택 `lms.korea.ac.kr/*` 호스트 권한으로 `tabs.query({url})` 한 뒤 각 탭 최상위 프레임에 값 없는 무효화 신호 `POPUP_AUTO_CLOSE_CHANGED`만 보냅니다. 페이지는 이 확장 워커가 보낸 정확한 신호에만 다시 요청하고 가장 최근 요청의 응답만 적용하므로, 늦게 도착한 이전 응답이 새 설정을 덮지 않습니다. 따라서 로컬 데이터 모두 삭제나 끄기 후 이미 열린 포털 페이지도 즉시 관찰을 멈추고, 다시 켜면 재개합니다. 설정값 외의 데이터·탭 URL은 메시지에 싣지 않으며 광범위 `tabs` 권한, 새 상시 권한, CSP 변경은 없습니다. 개발용 자동 재생 빌드의 삭제 경로는 재생 키만 지우므로 이 키를 명시적으로 함께 제거합니다.
- 클릭 대상은 `#xn-popup-wrapper > .xnp-item-wrapper[data-popup-id] > .xnp-item-close > button.xnp-item-close-button`와, 미참여 설문 안내 `#xn-lms-term-survey-list .xnlts-button-container > .xnlts-button.blue` 중 텍스트가 정확히 ‘설문 나가기’인 요소뿐입니다. 같은 컨테이너의 ‘로그아웃’, ‘새로고침’, 설문 목록 항목은 클릭하지 않으며 설문을 열거나 제출하지 않습니다. 설문 안내는 문서 전체의 자식 추가를 관찰하며 시도한 요소는 다시 클릭하지 않습니다. 유지되는 wrapper의 자식 추가를 관찰합니다. ‘오늘 하루 보지 않기’ 체크박스, 페이지 콘텐츠 저장소, 다른 페이지 컨트롤은 조작하지 않습니다. 네트워크 API 및 telemetry를 사용하지 않습니다.
- 배포 검사는 manifest 콘텐츠 스크립트를 `lms.js` 하나로 한정하고(JS 배열·LMS 호스트 matches·최상위 프레임·`document_idle`), 상시 호스트 목록에 포털이 없음과 `optional_host_permissions`가 정확히 포털 하나임을 검사합니다. ZIP 파일 allowlist는 런타임 등록 파일 `content-scripts/lms-popup.js`만 추가하며 기존 기능 권한·CSP 및 자동 재생 제외 검사를 유지합니다. E2E 재생 빌드 판별은 팝업 스크립트 수가 아니라 `player.js` 존재를 기준으로 유지합니다.
- 남은 검증: 실제 LMS와 Chrome 114에서 기본 비활성, 권한 프롬프트 허용·거절, 켜기/끄기·로컬 삭제(이미 열린 포털 탭 포함), `chrome://extensions`에서 권한 회수, 브라우저 재시작·확장 업데이트 뒤 등록 유지, 서비스 워커가 유휴 종료된 뒤의 설정 변경 전파, bfcache 복원 후 재요청, wrapper 유지 상태의 후속 팝업, 지정 셀렉터 밖의 컨트롤과 ‘오늘 하루 보지 않기’ 체크박스 불변, 설문 안내가 실제로 `lms.korea.ac.kr` 최상위 프레임에 나타나는지와 ‘설문 나가기’ 이후 LMS 동작을 확인해야 합니다. 페이지가 닫기 버튼에 연결한 자체 동작은 LMS 경계에 속합니다.

## 2026-10-21 게시판 영상 녹화 후보·일정 종류 구분

실제 LMS(2026-10-21, 로그인된 Chrome에서 읽기 전용 API 조회)에서 확인한 사실과 변경 경계입니다. 실제 확장 설치 상태의 탭 열기·재생 검증은 아직 수행하지 않았습니다.

- 확인한 구조: 일부 과목은 수업 녹화를 주차학습 모듈이 아니라 LearningX 게시판(과목 메뉴의 외부 도구 `/courses/:cid/external_tools/:tid`) 글로 올립니다. 게시글 목록 API(`.../boards/:bid/posts?page=N`)의 `content` HTML에 `<iframe src="https://kucom.korea.ac.kr/em/{13자리 16진수}">`가 들어 있고, 상세 API의 `content`와 동일합니다. 이 플레이어 페이지는 LMS 세션 없이도 단독 탭에서 재생됩니다. 게시판 글을 LMS에서 열어도 최상위 주소는 `/courses/:cid/external_tools/:tid`로 고정되고 글은 `/learningx/redirect/...?post_id=...&target=...` 리다이렉트와 post-message로만 열리므로, 특정 글을 여는 깨끗한 LMS 경로는 없습니다.
- 녹화 강의 목록(`RECORDINGS_LIST`)은 기존 모듈 외부 도구 항목 뒤에 게시판 영상 후보를 덧붙입니다. 기존 게시판 첨부 수집과 같은 세 GET 경로·같은 토큰 규칙·같은 300요청 예산을 쓰며(`src/api/board-collection.ts`), 토큰이 없거나 게시판 목록이 401/403/404면 모듈 후보만 표시합니다. 2026-10-23부터 그 밖의 게시판 실패(이후 글 목록·상세 요청 오류, 형식 오류, 300요청 예산 초과, 합계 10,000행 초과)나 게시판 단계가 쿼리 20초 예산 중 마지막 2초 안으로 들어가는 경우에도 게시판 영상 전체를 버리고 모듈 후보만 반환하며, 결과에 `boardsUnavailable: true`를 붙여 패널이 안내합니다. 게시판 영상은 일부만 반환하지 않고 모듈 목록의 실패 규칙(부분 결과 금지)도 그대로입니다. 글 목록의 `content`에서 `src/recordings.ts`의 `playerEmbeds`가 iframe `src`만 읽고, 그중 정확히 `https://kucom.korea.ac.kr/em/{8–32자리 소문자 16진수}` 경로만 query·fragment를 버린 정규 형태로 남깁니다(글당 최대 20개, 중복 제거, 예약(`reserved_at` 미래) 글 제외). 글 상세는 게시판당 영상이 있는 첫 글 1건만 읽어 `post_url`에서 같은 과목의 도구 ID를 얻고, 다른 과목의 도구를 가리키면 그 게시판은 건너뜁니다.
- 공개 투영 `Recording`에 `source: "module" | "board"`를 추가했습니다. `parseResult`는 두 값만 받아들입니다. 게시판 영상 행의 `lmsHandle`은 기존 자료와 같은 `/courses/:cid/external_tools/:tid`를, `launchHandle`은 플레이어 페이지를 엽니다. 패널에는 UUID 핸들만 전달되며 플레이어 주소·내부 ID는 content script 카탈로그에만 5분간 남습니다.
- `src/security/navigation.ts`의 `navigationUrl`은 기존 LMS 정규 경로에 더해 `playerUrl`이 받아들이는 정규 KU 플레이어 페이지 하나만 추가로 허용합니다(기존 호스트 권한 `https://kucom.korea.ac.kr/*` 범위, query·fragment·자격 정보·다른 경로·대문자·HTTP 거부). 백그라운드의 `OPEN_LMS_TARGET` 재검증도 같은 함수를 쓰므로 LTI 실행 URL 프록시나 임의 주소 열기는 여전히 불가능합니다. 순차 재생 배치(`takeRecordingBatch`)는 모듈 항목 경로만 받아들이므로 게시판 영상은 자동 재생 선택에서 제외되고 UI도 비활성으로 표시합니다.
- 남은 검증: 실제 확장에서 게시판 영상 ‘영상 열기’가 플레이어 탭을 열고 자막 감지가 그 탭에서 동작하는지, 플레이어를 LMS 밖에서 열었을 때 시청 기록 처리가 LMS 내 재생과 다른지(게시판 백업 영상은 출석 항목이 아니라는 가정), 게시판 글이 많은 과목의 요청 수와 20초 예산 내 완료 여부를 확인해야 합니다.
- 일정(`UPCOMING_LIST`)은 Planner 응답에 실제로 `announcement`·`assignment`·`quiz`가 섞여 오는 것을 확인했습니다. 패널은 `plannable_type`을 과제(assignment·quiz)/공지(announcement)/기타로 묶어 필터와 행 라벨을 표시하며, 투영·API 경로·허용 목록은 변경하지 않았습니다.

## 2026-10-23 PR 6 리뷰 반영

- 게시판 iframe 추출(`playerEmbeds`)은 `<iframe` 시작마다 그 태그의 첫 `>`까지만 잘라 속성을 읽고, 닫히지 않은 태그를 만나면 탐색을 끝냅니다. 2,000자를 넘는 태그는 건너뜁니다. 이전 정규식은 닫히지 않은 `<iframe `가 반복되면 시작마다 끝까지 재탐색해(8/16/32/64 KB에서 약 40/163/658/2,644 ms) 게시글마다 content script를 동기적으로 막을 수 있었습니다. 500,000자 제한 이하의 비정상 입력 회귀 테스트(`tests/recordings.test.ts`)가 200 ms 안에 끝나는지 확인합니다. 실제 LearningX가 이런 HTML 저장을 허용하는지는 확인하지 않았습니다.
- 녹화 강의 목록의 게시판 영상 실패 격리와 포털 선택 권한 전환은 위 해당 절에 반영했습니다.
- 앞선 검토에서 의심한 ‘게시판 영상 탭에서 자막 추출 불가’는 사실이 아니었습니다. 자막 감지는 LMS 쿼리 경로(`allowedPage`)가 아니라 활성 HTTPS 탭에 대한 `scripting`과 KU 플레이어 호스트 권한을 쓰며, 합성 서버에서 최상위 `kucom.korea.ac.kr/em/...` 탭의 화면 자막 감지를 확인했습니다. 실제 KU 플레이어 탭에서의 확인은 남아 있습니다.

## 2026-10-23 AI 자막 생성 (개발 빌드 전용)

이 기능은 `UNIDOCK_AI_CAPTIONS=1` 빌드에서만 컴파일됩니다. `scripts/package-release.mjs`가 이 플래그로 만든 빌드의 패키징을 거부합니다. 번들에서 CDN 호스트, `declarativeNetRequest`, 작업 API 경로, `unidock.caption-` 저장 키, 규칙 포트 이름, AI 자막 분석 이름(`captions_ai`, `caption_server_`)이 나오면 패키징이 실패합니다. 배포 빌드에는 이 기능의 코드·버튼·설정이 없습니다.

### 권한과 호스트
- 플래그 빌드에만 `declarativeNetRequestWithHostAccess` 권한을 넣습니다. 설치 경고가 없고 보유한 호스트 권한 범위에서만 동작합니다.
- CDN 호스트(`korea-cms-object.cdn.gov-ntruss.com`)는 `optional_host_permissions`에 둡니다. 설치 시점에는 요청하지 않습니다. 사용자가 확인 단계에서 `음성 보내기`를 누르면 패널이 그 클릭 처리 안에서 `chrome.permissions.request`로 이 호스트를 요청합니다. 사용자가 거부하면 작업은 `PERMISSION` 오류로 멈추고 어떤 요청도 보내지 않습니다. 이 권한이 없으면 세션 규칙이 헤더를 바꾸지 못하고, CDN에 CORS 헤더가 없어서 읽기도 막힙니다.
- 자막 서버 origin은 빌드 상수 `UNIDOCK_CAPTION_SERVER`로 고정하고 CSP `connect-src`에만 추가합니다.
- 2026-10-24부터 플래그 빌드에 `identity` 권한을 넣습니다. Google 로그인은 `chrome.identity.launchWebAuthFlow` 창에서 일어나므로 `connect-src`에 Google 주소를 넣지 않습니다. OAuth client ID는 빌드 상수 `UNIDOCK_GOOGLE_CLIENT_ID`이고, 선택 항목 `UNIDOCK_EXTENSION_KEY`가 있으면 manifest `key`로 확장 ID를 고정합니다. 배포 빌드에는 `identity`도 `key`도 없고, 패키징이 `accounts.google.com`, `launchWebAuthFlow` 마커를 검사합니다.

### DNR 세션 규칙
- 오디오를 받기 시작할 때 세션 규칙 하나를 추가합니다. 규칙 ID는 작업마다 1947000~1947999 범위에서 새로 고릅니다. 영구 규칙과 정적 규칙 파일은 두지 않습니다.
- 규칙을 없애는 경로는 세 가지입니다. 첫째, 패널은 성공·실패·취소 때 `finally`에서 규칙을 제거합니다. 둘째, 패널은 규칙을 건 동안 background와 포트(`unidock-caption-rule:<규칙 ID>`)를 열어 둡니다. 패널이 닫히거나 죽어서 포트가 끊기면 background가 그 규칙을 제거합니다. background는 확장 패널에서 열린 포트만 받습니다. 셋째, background 워커가 시작하면 10초 뒤에 연결된 포트가 없는 이 범위의 규칙을 모두 제거합니다.
- Chrome 114부터는 열린 포트만으로는 워커의 유휴 타이머가 늘어나지 않습니다. 그래서 패널은 오디오를 분리하는 동안 20초마다 이 포트로 keepalive 메시지를 보냅니다.
- 그래도 워커가 내려가면 패널의 포트가 끊깁니다. 이때 패널은 같은 이름으로 포트를 다시 엽니다. 새 워커는 이 포트를 받아 규칙을 사용 중으로 표시하고 `ready`로 답합니다. 패널은 `ready`를 받으면 같은 규칙을 지웠다가 다시 추가하므로, 정리가 규칙을 지웠더라도 복구합니다. 시작 정리는 10초 유예 뒤에 실행되므로 그 사이 다시 연결한 패널의 규칙은 지우지 않습니다.
- 패널은 `ready`를 받을 때마다 재연결 실패 횟수를 0으로 되돌립니다. 따라서 워커가 여러 번 다시 시작해도 패널은 계속 다시 연결합니다. 다시 연결을 멈추는 경우는 `ready` 없이 연속 5번 끊길 때뿐입니다. 작업이 끝난 패널은 포트를 다시 열지 않고 keepalive도 멈춥니다.
- CDN이 요청을 거부(401·403)하면 패널은 "강의 영상 서버가 요청을 거부했습니다"를 보여줍니다. 음성 트랙이 없는 파일과 구분합니다.
- 규칙 제거가 실패하면 콘솔에 경고를 남깁니다. 이때도 위의 다른 경로가 규칙을 다시 지웁니다.
- 규칙 조건은 호스트 하나, 해당 미디어 URL 하나(`urlFilter`), `initiatorDomains`는 확장 자신, `resourceTypes`는 `xmlhttprequest`입니다. 동작은 `Referer: https://kucom.korea.ac.kr/` 설정 하나입니다. 탭의 일반 요청은 바꾸지 않습니다.

### 데이터 흐름
- 미디어 URL은 사용자가 보고 있는 kucom 플레이어의 `uniPlayerConfig` 데이터 속성에서만 읽고, 고정 패턴(13자리 hex 콘텐츠 ID)을 통과한 값만 씁니다. 임의 URL을 받는 경로는 없습니다.
- 영상은 받지 않습니다. 파일 0번 바이트부터 최상위 박스 헤더만 따라가 `ftyp`과 `moov`의 위치를 찾습니다. 그래서 `moov`가 앞에 있는 파일과 끝에 있는 파일을 모두 처리합니다. 헤더는 8바이트만 읽고, 크기 값이 1(64비트 largesize)일 때만 8바이트를 더 읽습니다. 따라서 `mdat` 헤더 바로 뒤의 첫 샘플이 영상이어도 영상 바이트를 읽지 않습니다. 그 다음 오디오 트랙 샘플의 바이트 범위만 Range로 받아 mp4box로 조각화된 `.m4a`를 만듭니다. mp4box에는 실제 파일 바이트를 실제 오프셋에 넣습니다.
- CDN 응답은 206이고 `Content-Range`의 시작·끝·전체 길이가 요청과 같을 때만 받습니다. 다르면 본문을 읽기 전에 요청을 중단합니다. 본문이 요청 길이를 넘어도 즉시 중단합니다. 따라서 Range를 무시한 200 응답이 영상 전체를 메모리에 올리는 경로는 없습니다.
- 영상·음원 파일을 사용자에게 저장·제공하지 않습니다. 결과물은 자막뿐입니다.
- 음성은 메모리에서만 처리하고 `chrome.storage`·IndexedDB·`chrome.downloads`로 내보내지 않습니다. `chrome.downloads`는 자막 TXT·JSON 내보내기에만 씁니다.
- 자막 서버 API 계약은 `documentation/api/public.openapi.yaml`(비공개 서버 저장소의 공개 API 사본)입니다. 이 API는 OpenAI API와 호환되지 않습니다. 음성은 이 서버로만 보냅니다. 업로드는 tus 방식의 `HEAD`/`PATCH`이고, 크기는 첫 `PATCH`의 `Upload-Length`로 선언하며 끊기면 서버 offset부터 이어 보냅니다. 서버가 이 작업에 다른 크기를 기록하고 있으면(`UPLOAD_LENGTH_MISMATCH`) 같은 키로 다시 요청해도 같은 작업이 돌아오므로, 패널은 그 작업을 취소해 키를 풀고 같은 음성으로 새 작업에 한 번만 다시 올립니다. 다른 곳에서 이미 업로드가 끝난 작업(`UPLOAD_NOT_ACCEPTING`)은 실패로 보지 않고 그 작업 상태를 따라갑니다.
- 서버 요청 본문·헤더·로그·분석에 LMS URL, 과목 ID, 강의 제목, KU 콘텐츠 ID를 넣지 않습니다. `Idempotency-Key`는 설치마다 다른 32바이트 salt(`unidock.caption-install-salt.v1`)로 콘텐츠 ID의 HMAC-SHA256을 계산해 만듭니다. 같은 설치에서 같은 강의를 다시 요청하면 같은 키가 나오므로 서버가 기존 작업을 돌려줍니다. 작업이 실패·취소되거나 자막이 만료되면 서버가 키를 풀어 같은 강의를 다시 요청할 수 있습니다. salt가 설치마다 다르므로 이 키로는 다른 사용자의 작업과 연결되지 않습니다. 다른 사용자가 이미 만든 자막의 재사용은 서버가 업로드된 음원으로 계산한 digest로만 합니다.
- 패널은 오디오를 받기 전에 작업을 만듭니다. 서버가 이미 접수한 작업(`awaiting_upload` 다음 상태)을 돌려주면 오디오를 다시 받지 않고 그 작업 상태를 보여줍니다. 업로드가 끝난 작업은 작업 ID와 그 강의의 작업 키를 함께 `unidock.caption-active-job.v1`에 저장합니다. 패널을 다시 열면 현재 플레이어 탭의 강의 키를 계산하고, 저장한 키와 같을 때만 이 작업의 상태를 서버에 다시 조회합니다. 다른 강의나 플레이어가 아닌 탭에서는 이전 자막을 보여주지 않습니다. 저장소를 읽는 동안 사용자가 새 생성을 시작하면 늦게 도착한 복원 결과는 버립니다.
- 패널을 닫아도 서버 작업은 취소하지 않습니다. 서버 작업을 취소하고 저장한 작업을 지우는 경우는 두 가지입니다. 첫째, 사용자가 취소 버튼을 누릅니다. 둘째, 작업을 시작한 플레이어 탭이 다른 주소로 이동하거나 닫히거나, 같은 창에서 다른 탭을 고릅니다. 다른 탭이나 다른 창의 이벤트는 작업에 영향을 주지 않습니다. 패널을 다시 열어 복원한 작업은 탭 이벤트로 취소하지 않습니다.
- 인증은 Google 로그인입니다. 패널이 authorization code + PKCE(S256)를 받고 state가 일치할 때만 code와 verifier를 자막 서버에 한 번 보냅니다. 서버가 Google과 교환·검증한 뒤 자체 세션(access 15분, refresh 30일·교체형)을 줍니다. `chrome.storage.local`의 `unidock.caption-session.v1`에는 이 세션과 표시용 이메일만 두고 Google 토큰·인가 코드는 저장하지 않습니다. access가 만료되면 refresh를 한 번만 하고(여러 패널이 동시에 해도 Web Locks로 한 번), 서버가 세션을 거부하면 지우고 다시 로그인을 요구합니다. 로그아웃과 로컬 데이터 삭제는 세션 Web Lock 안에서 서버 세션 폐기(`POST /v1/auth/logout`, 3초 제한) → 세션·salt·작업 ID 삭제 → 무효화 표식(epoch) 갱신 순서로 처리합니다. epoch는 디스크에 남지 않는 `chrome.storage.session`에 둡니다. 그 전에 시작한 로그인이나 refresh의 응답이 늦게 오면 epoch가 달라졌으므로 저장하지 않고, 그 응답의 세션도 서버에서 폐기합니다. refresh는 같은 lock을 쥔 채 진행하므로 lock이 있는 환경에서는 삭제가 refresh 뒤로 줄을 섭니다. playback 플래그를 함께 켠 빌드에서도 같습니다.
- 재생·탐색·배속·출석 API를 호출하지 않습니다. 사용자가 직접 재생한 영상의 음성만 대상으로 합니다.

### 남은 위험
- 자막 서버(2단계)와 모델 PoC(1단계)는 별도 저장소에서 진행하며, 이 저장소의 테스트는 가짜 서버·가짜 CDN 기준입니다. 실제 LMS·실제 CDN·실제 서버 종단 검증은 수동 게이트로 남습니다.
- 재다중화는 ffmpeg로 만든 합성 MP4 두 개(`moov`가 앞에 있는 파일, 끝에 있는 파일)와 실제 mp4box로 검증했습니다. 분리 과정의 peak 메모리는 실제 강의 파일(463 MB 표본)로 아직 측정하지 않았습니다. 코드는 오디오 표본 합계가 100 MB를 넘으면 `TOO_LARGE`로 멈추고, 쓴 샘플은 조각마다 mp4box에서 해제합니다.
- 인접하지 않은 오디오 범위는 범위마다 Range 요청을 하나씩 보냅니다. 영상 바이트를 받지 않기 위해 범위를 합치지 않았습니다. 긴 강의에서는 요청 수가 많아질 수 있습니다. 실제 KU 파일의 interleave 간격은 아직 측정하지 않았습니다.
- 현재 탭이 kucom 최상위 탭일 때만 미디어를 읽습니다. LMS 페이지의 iframe에 들어간 플레이어를 지원할지는 확인이 필요합니다.
- 스토어 제출은 이 범위 밖입니다. 제출 시 개인정보처리방침과 스토어 고지에 음성 전송을 사실대로 신고해야 합니다.
