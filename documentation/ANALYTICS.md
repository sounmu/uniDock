# 선택적 사용 통계 운영

## 구성

`src/analytics/contract.ts` → 패널의 `analytics.ts`/`useAnalytics.ts` → 검증된 background 메시지 → `AnalyticsRuntime` → DOM 없는 `@posthog/core` stateless 어댑터. SDK는 동의하고 이벤트가 발생한 후에만 초기화합니다. 콘텐츠 스크립트에 분석 코드를 주입하지 않습니다.

로컬 키 `unidock.analytics.v1`: 동의 시 `{ version: 1, enabled: true, id: <random UUID> }`, 거절/철회 시 `{ version: 1, enabled: false }`. 모든 데이터 삭제는 키를 제거합니다. 로컬 이벤트 큐, SDK 쿠키/localStorage/IndexedDB는 없습니다. 저장 형식이 잘못되면 동의로 간주하지 않습니다.

동의는 같은 브라우저 프로필의 패널들에서 공유됩니다. 이미 동의한 상태에서 다른 패널도 동의를 저장하면 같은 설치 ID를 유지합니다. **철회 또는 전체 삭제 후 다시 동의할 때** 새 ID가 만들어집니다. 설정 변경은 `chrome.storage.onChanged`로 열린 패널에 반영합니다.

## 빠른 시작: `.env.local`에 한 번 설정

프로젝트 루트의 `.env.local`에 EU 프로젝트의 **공개 수집 토큰**을 저장합니다.

```dotenv
VITE_POSTHOG_KEY=phc_your_project_token
```

```sh
npm run build
```

이후 빌드마다 자동으로 읽으므로 명령 앞에 토큰을 반복해서 붙일 필요가 없습니다. 셸에 같은 이름의 환경변수가 있으면 파일보다 우선하므로, 다른 프로젝트로 전송될 때 먼저 확인하세요. 현재 호스트는 `https://eu.i.posthog.com`으로 고정되어 있습니다.

1. `chrome://extensions`에서 `.output/chrome-mv3`로 로드한 uniDock을 새로고침합니다. 처음이면 이 폴더를 압축해제된 확장으로 로드합니다.
2. 기존 패널을 닫고 다시 열고, LMS 탭도 새로고침합니다.
3. **정보 → 사용 통계 공유 → 동의하고 통계 공유**를 선택합니다. 이미 동의했다면 재동의할 필요가 없습니다.
4. 화면을 전환하거나 버튼을 누르고 PostHog **Activity → Explore**에서 `panel_opened`, `screen_viewed`, `action_clicked` 등의 수신을 확인합니다. 처음 동의한 시점 이전의 활동은 나타나지 않습니다.

토큰은 빌드 시 JS에 포함되는 공개 값입니다. `.env.local`은 버전 관리에서 제외되어 다른 개발자/CI에 자동 전달되지 않습니다. 개인·관리 API 키를 이 변수에 넣지 않습니다. 파일만 바꿔서는 이미 설치한 확장에 반영되지 않으며, 빌드 후 재로드가 필요합니다. `npm run dev`는 토큰이 있어도 수집하지 않습니다.

**배포 ZIP은 별도입니다.** `npm run build`는 `.output/`만 갱신합니다. 토큰을 넣기 전에 만든 `release/` ZIP은 그대로이므로 배포할 파일은 `.env.local`을 설정한 상태에서 `npm run release`로 다시 생성합니다. `.env.local` 자체는 ZIP에 포함되지 않습니다.

## 이벤트 사전

| 이벤트 | 필드 | 정의 |
| --- | --- | --- |
| `panel_opened` | screen | 동의 상태에서 패널 계측 시작. 열린 패널에서 처음 동의한 경우도 포함 |
| `screen_viewed` | screen | 고정 최상위 화면 변경. 개별 LMS 항목 제목/ID는 제외 |
| `action_clicked` | screen, action | 코드에서 지정한 버튼·선택기 동작. 필터 입력값은 미수집 |
| `panel_engagement` | screen, visible_seconds, active_seconds | 가시 시간과 포커스+최근60초 활동 시간의 증가분. 세션 총합이 아님 |
| `feature_result` | feature, outcome | 동의 중 시작한 기능의 success/failure. LMS 결과 내용·오류 메시지 제외 |

공통 wire 메타데이터: 설치 distinct_id, extension_version, 이벤트 timestamp/uuid, SDK의 고정 $lib/$lib_version, `$geoip_disable: true`, `$process_person_profile: false`, `$ip: null`. 서버가 반환하는 본문은 읽지 않습니다.

시간은 단조 시계로 5초마다 확인하고 30초마다 전송합니다. 화면 변경·가시성 변경·포커스 상실·`pagehide` 때도 남은 시간을 전송 시도합니다. 최근 활동에는 계측 시작, 포커스 복귀, 포인터 누름·키 누름·스크롤이 포함되며 입력 내용은 읽지 않습니다. 10초 넘는 타이머 공백은 절전/스로틀링으로 간주해 제외합니다. 초 미만은 누적하고, 전송 값은 각 0–60초이며 `active_seconds`는 `visible_seconds` 이하입니다. 표시 시간이 1초 미만이면 해당 전송을 생략합니다. 종료 직전 전송은 보장되지 않습니다.

버튼 목록은 `actions`, 화면 목록은 `screens`, 결과 기능은 `features` 상수가 기준입니다. 새 버튼은 정적 allowlist 항목과 `data-analytics-action`을 함께 추가하세요. 설정 동의/철회와 삭제 확인 자체는 계측하지 않습니다. 체크박스는 click, 날짜/선택기는 change로 1회 계측합니다. 키/입력내용/마우스 좌표/DOM 구조는 수집하지 않습니다.

`download` 성공은 **다운로드 요청 접수**이며 파일 저장 완료나 정상 PDF 내용 보장이 아닙니다. `playback_start` 성공은 **시작 명령 접수**, 강의 종료/출석 보장이 아닙니다. `ai_handoff` 성공은 프롬프트 복사+탭 열기이며 AI 제출/응답을 측정하지 않습니다. 화면 이동으로 폐기한 결과는 일부 기능에서 제외됩니다.

## 운영 연결 순서

1. PostHog **EU 리전**에서 운영 프로젝트와 테스트 프로젝트를 분리합니다.
2. IP 폐기 설정을 켜고 GeoIP 보강, 자동 수집, replay, heatmaps, surveys, flags를 사용하지 않습니다. 코드가 remote config를 읽지 않으므로 서버 옵션으로 기능을 켤 수 없습니다.
3. 원시 이벤트의 보관 기간을 **최대 90일**로 설정하고 만료 삭제를 실제 검증합니다. 프로젝트/플랜에서 기간 설정을 지원하지 않으면 서버측 주기 삭제를 마련하거나 수집을 활성화하지 않습니다. 브라우저 코드로 서버 보관을 보장할 수 없습니다.
4. 최소 인원만 프로젝트 접근 권한을 갖도록 설정합니다. 지원 문의의 설치 ID로 원격 이벤트를 삭제하는 절차를 검증합니다. Person profiles가 없으므로 프로필 삭제만으로 충분하다고 간주하지 말고 이벤트 삭제 결과도 확인합니다. 관리자 키는 운영 환경에만 보관합니다.
5. 공개 개인정보 처리방침·지원 연락처·스토어 데이터 고지를 갱신합니다. 기존 사용자는 동의 전 수집하지 않습니다.
6. 위의 `.env.local`을 설정한 상태에서 `npm run release`를 실행합니다. 일회성 재정의가 필요하면 `VITE_POSTHOG_KEY=phc_... npm run release`도 가능합니다. 공개 수집 토큰만 빌드에 포함합니다. 토큰이 없거나 형식이 잘못되면 설정 UI에 미연결로 표시하고 동의를 활성화하지 않습니다. 형식 검사는 프로젝트 유효성·리전·수신 성공 검증이 아닙니다. HMR 빌드도 비활성입니다.
7. 가상 LMS로 실제 테스트 프로젝트 수신을 확인한 후 운영 토큰 빌드에서 공개 문안과 호스트/보관 정책의 일치를 확인합니다. 이 저장소 작업은 계정 생성·원격 설정·스토어 제출을 대신하지 않습니다.

수집 토큰은 공개되므로 외부의 가짜 이벤트 주입을 완전히 막지 못합니다. 제품 분석 수치에 테스트/스팸 데이터가 섞이지 않는지 점검하세요. 계측은 best-effort: background 인스턴스당 동시 4개/60초 구간당120개이며 워커 재시작 시 카운터가 초기화됩니다. 재시도·오프라인 백필은 없습니다. 여러 패널의 표시 시간은 겹칠 수 있습니다. 활성 시간은 포커스 기준이며 브라우저/OS 동작에 따른 오차가 있습니다.

## 대시보드 구성

### 그래프를 한 화면에 모으기

1. PostHog의 해당 EU 프로젝트에서 **Dashboards → New dashboard → Blank dashboard**를 선택합니다.
2. 이름을 **uniDock 사용 현황**으로 지정하고 설명에 **통계 공유에 동의한 설치의 표본**이라고 적습니다.
3. **New insight**에서 아래 그래프를 만들고 **Save & add to dashboard**로 저장합니다. 기존 그래프는 **Add to dashboard**로 추가합니다.
4. 비교할 날짜 범위와 프로젝트 시간대(예: Asia/Seoul)를 일관되게 설정합니다. DAU/WAU/MAU 숫자 카드에는 각각 기간을 명시하고, 대시보드 전체 날짜 필터가 이 기간을 덮어쓰지 않도록 타일별 필터를 확인합니다.

`$pageview`를 수집하지 않으므로 웹사이트용 Web Analytics/템플릿은 비어 있을 수 있습니다. 아래 맞춤 이벤트로 Product Analytics 그래프를 구성합니다. 대시보드는 확장이 자동 생성하지 않습니다.

| 그래프 | Insight / 이벤트 | 집계·분류 |
| --- | --- | --- |
| 일별 패널 이용 설치 | Trends / `panel_opened` | Unique users, 일별 꺾은선. 패널을 새로 열지 않고 계속 쓰는 설치는 이 지표에서 빠질 수 있음 |
| 버튼별 클릭 횟수 | Trends / `action_clicked` | Total count, Breakdown=`action`, 막대그래프 |
| 버튼별 이용 설치 | Trends / `action_clicked` | Unique users, Breakdown=`action`. 클릭 횟수와 별도 그래프로 저장 |
| 화면별 조회 수 | Trends / `screen_viewed` | Total count, Breakdown=`screen` |
| 화면별 활성 시간 | Trends / `panel_engagement` | `active_seconds` 속성의 Sum, Breakdown=`screen`, 단위 초. 표시 시간은 `visible_seconds`로 별도 시리즈 |
| 기능별 실패율 | Trends / `feature_result` | A: `outcome=failure`의 Total count, B: 전체 Total count, 둘 다 Breakdown=`feature`; Formula=`100 * A / B`, 단위 %. B=0은 데이터 없음으로 해석 |
| 재방문율 | Retention | 시작 `panel_opened`의 최초 발생, 반환은 아래 활동 이벤트 집합. 일 단위 D1/D7/D30 |
| 자료 이용 퍼널 | Funnels / `action_clicked` | 각 단계에 action 필터: `course_select` → `tab_materials` → `download_batch` 또는 `download_one` → `ai_handoff` |

**활성 설치(DAU/WAU/MAU)**를 정확히 정의하려면 `panel_opened`, `screen_viewed`, `action_clicked`, `panel_engagement`를 OR로 묶은 PostHog Action을 만들고 그 Action의 Unique users를 사용합니다. 각 이벤트의 고유 사용자 수를 더하면 중복 집계됩니다. DAU는 1일, WAU는 최근 7일, MAU는 최근 30일 동안의 고유 설치로 정의하며 일별 고유 사용자 수를 합산하지 않습니다. 수동 작업에서는 이벤트 원시 필드가 `distinct_id`인지 확인하고 LMS 계정 식별자로 대체하지 않습니다.

**평균 시간**은 `active_seconds`의 이벤트별 평균이 아닙니다. 이벤트가 시간 조각이므로 우선 Sum으로 보고, 평균이 필요하면 같은 기간의 합계/고유 설치 수 또는 합계/패널 열기 수를 명시적으로 계산합니다. 후자는 패널을 열린 채로 기간 경계를 넘기거나 다시 동의한 경우 오차가 있는 근사치입니다. SDK의 기본 웹 세션 시간을 사용하지 않습니다.

**리텐션**은 최초 관측된 패널 이용 이후 같은 설치가 다시 활동했는지를 봅니다. D7/D30은 그만큼 시간이 지난 집단에만 데이터가 생깁니다. 최초 관측은 확장 설치일과 같지 않으며 동의 시점 이전 활동은 알 수 없습니다. `on day`와 `on or after` 중 어떤 반환 조건을 선택했는지도 제목에 표시합니다. Person Profiles나 `identify()` 호출은 필요하지 않습니다.

**기능 이용률**은 해당 action의 고유 설치 수/같은 기간 활성 설치 수입니다. 기능 실패율은 기능 실행 결과 기준이며 사용자 수 비율과 다릅니다. 단순 클릭이 없더라도 화면 진입 시 실행되는 `playback_refresh` 결과가 발생할 수 있습니다.

### PostHog AI로 시작하기

PostHog AI를 사용할 수 있다면 다음 요청으로 초안을 만들고 이벤트·집계 설정을 확인합니다.

> “uniDock 사용 현황” 대시보드를 만들어줘. panel_opened의 일별 고유 사용자, action_clicked의 action별 클릭 수와 고유 사용자, screen_viewed의 screen별 조회 수, panel_engagement의 active_seconds 합계, feature_result의 feature별 실패율(outcome=failure 건수/전체 건수), 최초 panel_opened 이후 재방문율을 보여줘. 모든 지표는 통계 공유에 동의한 설치 기준이라고 표시해줘. active_seconds는 시간 조각이므로 평균 대신 합계를 사용해줘.

[PostHog 대시보드 공식 안내](https://posthog.com/docs/product-analytics/dashboards)

모든 대시보드에 **동의한 설치의 표본**이라고 표시합니다. 재동의/재설치/여러 프로필은 서로 다른 설치입니다. 스토어 설치 수와 같지 않습니다.

## 수신이 안 되거나 그래프가 비어 있을 때

| 상태 | 확인할 항목 |
| --- | --- |
| ‘분석 서비스가 연결되지 않음’ | `.env.local` 변수 이름·공개 토큰 형식, 셸 변수 우선순위, production 빌드 여부, 확장 재로드 여부 |
| 연결됐지만 이벤트 없음 | 사용자 동의, EU 프로젝트 선택, 새 화면 이동/버튼 사용, 오프라인·요청 제한 여부 |
| 이벤트는 보이나 그래프 없음 | 이벤트 이름·기간·시간대·속성 필터, Unique users/Total count/Sum 선택, 그래프 새로고침 |
| 활성 시간이 적거나 0 | 패널 포커스 여부, 60초 유휴 기준, 절전/종료 손실. 영상 시청 시간과는 다른 지표 |
| D7/D30 리텐션 없음 | 수집 시작 이후 충분한 기간이 지났는지 확인. 설치 ID가 재동의로 바뀌었는지 확인 |
| 로컬에서는 되지만 배포 ZIP에서는 안 됨 | 토큰 설정 후 `npm run release`로 ZIP을 다시 생성했는지 확인 |

## 검증

```sh
npx vitest run tests/analytics.test.ts tests/analytics-client.test.ts tests/background.test.ts
npm run test:e2e:analytics
```

`test:e2e:analytics`는 가짜 공개 토큰으로 production 빌드하고 실제 SDK 요청을 Playwright에서 응답해 외부 서버로 보내지 않습니다. 종료 시 기존 환경 설정(`.env.local` 포함)으로 다시 빌드해 가짜 토큰 산출물을 제거합니다. CI에서도 이 경로를 실행합니다. 일반 `test:e2e`의 분석 테스트는 빌드에 키가 없으면 무수집 경로, 키가 있으면 요청을 가로채 동의 경로를 검증합니다. 자동화 수신 확인은 실제 PostHog 서버 수신과 별개입니다.

단위 테스트는 비동의·손상 저장값·키 없음·철회/삭제 경쟁·알 수 없는 필드·네트워크 실패·시간 계산을 검증합니다. 브라우저 검증은 production unpacked 확장에서 PostHog 요청을 가로채 실제 SDK wire payload, 동의/거절/철회/다중 패널/삭제 및 화면을 확인합니다. 실제 운영 프로젝트 수신, 서버 보관/삭제, Chrome 114와 실제 LMS/SSO는 별도 운영 확인 대상입니다.

### 2026-09-30 검증 결과

- `npm run release`: 34개 파일의 단위/UI 테스트 663개, lint·타입·Pages 동기화·production build·manifest/ZIP 검사 통과. npm audit 0개. `release/uniDock-0.1.2-chrome-mv3.zip` 생성(운영 토큰 미설정).
- 전체 Playwright E2E 28개 통과. 별도로 `npm run test:e2e:analytics`의 가짜 토큰 opt-in 시나리오 통과. 학습 fixture의 문자열·URL·기본 브라우저 프로필 속성이 전송 본문에 없음을 확인. 패널/서비스 워커 오류 없음.
- 커버리지 검사에서 전체 statements 85.61%, branches 82.63%, functions 91.51%, lines 88.31%로 80% 기준 통과(후속 중복 동의 회귀 2개 추가 전 수치).
- 320/420px 동의 화면과 삭제 후 화면을 캡처·확인. `.wxt/e2e/test-results/analytics-consent-*/`에 스크린샷 저장. 브라우저 테스트는 production 확장의 `sidepanel.html`을 탭으로 로드하므로 네이티브 Side Panel 및 OS별 포커스·가시성 동작은 실환경에서 추가 확인해야 합니다.
- 운영 PostHog 계정/토큰 연결·수신, 90일 만료 정책과 원격 삭제, 스토어/공개 정책 게시 및 실제 LMS/SSO 검증은 아직 수행하지 않았습니다.

### 2026-10-01 문서 점검 시점의 최신 상태

- 로컬 `.env.local` 설정 후 토큰 형식·production 빌드 포함·EU CSP 허용을 확인했습니다. 토큰 값은 문서에 기록하지 않습니다.
- **실제 PostHog 이벤트 수신은 사용자가 확인했습니다.** 이는 에이전트가 운영 프로젝트에 접속하여 속성·보관 설정·대시보드까지 검증했다는 의미는 아닙니다.
- 위 2026-09-30 기록의 ZIP은 토큰 미설정 상태로 만든 산출물입니다. 그 뒤 `npm run build`로 갱신한 `.output/`과 구분해야 합니다. 실제 배포 ZIP은 현재 설정으로 `npm run release`를 실행해 갱신해야 합니다.
- 대시보드 만드는 절차와 지표 정의는 준비했으며, 운영 프로젝트에서 대시보드를 실제 생성했는지는 확인되지 않았습니다.
- **개인정보 처리방침과 설정 화면에 명시된 최대 90일 보관은 운영상 약속입니다.** 확장 코드에 서버 이벤트 만료·원격 삭제를 수행하는 기능은 없습니다. PostHog의 IP 폐기, 90일 보관/만료, 설치 ID별 삭제 절차의 실제 적용은 아직 확인되지 않았으며, 수신 성공만으로 이를 완료 처리하지 않습니다. 실제 설정과 공개 고지가 일치해야 합니다.
- 스토어/공개 정책 게시, 지원 연락처 확정, 실제 LMS/SSO 및 Chrome 114 검증도 미확인 상태입니다. [출시 체크리스트](store/RELEASE-CHECKLIST.md)에서 관리합니다.
