# 사용 통계 (GA4 집계) 운영 안내

목적은 **제품 전체 수준**에서 세 가지를 아는 것입니다: 어떤 기능이 쓰이는지, 사용자가 실제 결과를 얻는지, 어떤 작업이 실패하거나 느린지. 개인별 행동 패턴·이동 경로·사용자별 타임라인은 측정하지 않으며 측정할 수 없게 설계했습니다.

- 장기 설치·사용자 식별자, 세션 리플레이, 광고 분석, 사용자별 퍼널은 없습니다.
- 이 설정은 법적 동의를 자동으로 대신하지 않습니다. GA4가 완전한 익명성을 자동으로 보장한다고 설명하지 않습니다.
- 모든 날짜는 **Asia/Seoul**(UTC+9, 서머타임 없음) 달력 날짜입니다.

코드 기준: 계약 `src/analytics/report.ts`, 메시지 `src/analytics/contract.ts`, 기기 집계 `src/analytics/runtime.ts`, 패널 계측 `entrypoints/sidepanel/analytics.ts`·`useAnalytics.ts`, GA4 매핑 `src/analytics/ga4.ts`, 보고서 계산 `src/analytics/metrics.ts`·`summary.ts`, 수집 서버 `server/stats/`([배포 안내](../server/stats/README.md)).

## 1. 데이터 흐름

```
패널(전면 UI) ──고정 코드 신호──▶ background (단일 writer: 일별 카운터·중복 방지 플래그·제한 큐)
                                       │ 약 10분마다 봉인한 불변 일별 delta 보고서 (일회성 report_id)
                                       ▼ HTTPS POST text/plain, 쿠키·referrer 없음
                              수집 API (Cloudflare Worker + D1)
                                       │ 엄격 검증 → report_id 중복 제거 → 날짜별 전체 합계에 원자적 가산
                                       ▼ 매시 :17 cron, 새로 늘어난 delta만
                              GA4 Measurement Protocol (집계 전용 property, api_secret은 서버에만)
                                       ▼
                         GA4 Explorations / Looker Studio / Data API (`npm run ga4:report`)
```

확장은 Google에 직접 연결하지 않습니다. 확장 번들에는 GA SDK·measurement ID·api_secret이 없으며 `scripts/package-release.mjs`가 이를 검사합니다. 콘텐츠 스크립트는 통계 메시지를 보낼 수 없습니다(background가 패널 발신자만 허용).

## 2. 서비스와 화면

| 서비스 | 화면 | 비고 |
|---|---|---|
| `courses` | COURSES_LIST, ASSIGNMENTS_LIST, RECORDINGS_LIST, DOCUMENTS_LIST | 과목 안의 과제→자료 이동은 재진입이 아님 |
| `tasks` | TODO_LIST, UPCOMING_LIST | 할 일↔일정 전환은 재진입이 아님 |
| `playback` | PLAYBACK | 재생 빌드에서만 |
| `captions` | CAPTIONS | |
| `settings` | INFO(설정) | 학습 서비스 비중·도달률 분모에서 제외 |

하위 화면 조회수(screen_view_count)는 v1에서 수집하지 않습니다. 추가하더라도 `service_entries`와 합산하지 않습니다.

**서비스 진입**(`useAnalytics.ts`): 패널이 서비스를 처음 보여줄 때(패널이 새로 열림) 또는 다른 서비스로 바뀔 때 1회. 다음은 세지 않습니다: 같은 서비스 안의 하위 화면 이동, React 재렌더, StrictMode effect 재실행(ref 유지), 같은 탭 재선택, 포커스·가시성 복귀, 자동 갱신. 설정은 덮개 화면이라 설정 진입은 `settings`로 세고, 설정에서 같은 학습 서비스로 돌아오는 것은 재진입이 아닙니다. 패널이 숨겨진 상태에서 열리면 처음 보일 때 셉니다. 여러 패널은 각자 자기 진입만 셉니다(한 행동이 여러 패널에서 중복 기록되지 않음).

## 3. 지표 정의

`설치-일` = 하루 동안 한 설치본이 기여한 1. 값은 **통계를 켜 두고 보고가 도착한 설치본**의 추정치이며 사람 수가 아닙니다. 끈 설치의 사용량은 알 수 없으므로 전체 설치 대비 이용률이나 opt-out 비율을 표시하지 않습니다. 모든 비율은 분모가 0이면 **N/A**, 기간 비율은 **기간 분자 합 / 기간 분모 합**입니다(일별 비율의 평균 아님).

| 지표 | 발생 조건 | 분자 / 분모 | 제외 | 날짜 기준 | 단위 |
|---|---|---|---|---|---|
| **A. 일별 활성 설치 수** `active_installs` | 전면 패널에서 서비스 진입 또는 핵심 결과가 기록된 첫 순간(설치별 하루 1회, 기기 안 플래그) | 합계 | 설치·업데이트·백그라운드 갱신·통계 전송 자체, 통계 OFF·안내 표시 전 | 활동 시각 | 설치-일 |
| A-보조 | 7일 이동평균: 해당 날짜 포함 직전 7일 평균(7일 중 하나라도 데이터 없으면 N/A). 전주 같은 요일: 7일 전 값과 변화율 | | | | |
| **B. 서비스 진입 수** `service_entries` | 위 "서비스 진입" 정의 | 합계 | 하위 화면·재렌더·재선택·자동 갱신 | 진입 시각 | 회 |
| **B. 서비스 사용 비중** | | 날짜 d의 서비스 s 진입 / 날짜 d의 학습 서비스(courses·tasks·playback·captions) 진입 합 | settings | 날짜별 분모 | % (같은 날짜 합 100%) |
| **C. 서비스 사용 설치 수** `service_installs` | 설치가 그날 서비스 s에 처음 진입(설치·서비스별 하루 1회) | 합계 | | 진입 시각 | 설치-일 |
| **C. 기능 도달률** | | 날짜 d의 s 사용 설치 / 날짜 d의 활성 설치 | | 같은 날짜 | % (서비스 합 100% 초과 가능) |
| 이용 강도 | | s 진입 / s 사용 설치-일 | | | 회/설치-일 |
| **D. 핵심 가치 도달 설치 수** `core_installs` | 전면(패널 visible)에서 핵심 결과가 처음 관측된 순간(설치별 하루 1회). 같은 순간 활성 플래그도 세우므로 분자는 항상 같은 날짜 분모에 포함 | 합계 | 화면 열기·버튼 클릭·작업 시작·숨겨진 prefetch, 패널이 숨겨진 상태의 결과 | 관측 시각 | 설치-일 |
| **D. 핵심 가치 도달률** | | 날짜 d `core_installs` / 날짜 d `active_installs` | | 같은 날짜 | % |
| 완료된 핵심 결과 수 `core_results` | 핵심 결과마다 | 합계 | | 관측 시각 | 회 |
| **E. 작업 시작/결과** `op_*` | 아래 작업 표 | started(시작일), success·failure·timeout·cancel(완료일) | 내부 HTTP 재시도, 관측 불능 | 시작·완료 시각 각각 | 회 |
| **E. 성공률** | | success / (success + failure + timeout) | cancel, 미완료 | 기간 합 | % |
| **E. 취소율** | | cancel / (success + failure + timeout + cancel) | 미완료 | 기간 합 | % |
| **F. 가중 평균 처리시간** | 성공한 논리 작업 | Σ duration_ms / Σ 표본 수 | 실패·취소, 24시간 초과 표본 | 완료일 | ms |
| **F. 근사 p95** | 고정 구간 누적 건수가 95%에 처음 도달한 구간의 상한 | | 평균으로 추정하지 않음 | | "≤ X" |
| **F. 오류 분포** `op_errors` | failure·timeout마다 고정 코드 1개(timeout은 항상 `TIMEOUT`) | 합계 | 원문·스택·URL | 완료일 | 회 |
| **G. 측정 상태** `pipeline_reports` | 수집 서버 수신 상태: accepted, accepted_late, duplicate, invalid, expired | 합계 | | **서버 수신일** | 보고서 수 |

다른 이벤트를 더해 이용 횟수를 만들지 않습니다(예: 활성 + 진입 + 핵심 결과 합산 금지). 일별 중복 제거 지표(A, C, D)는 버전으로 나누지 않습니다. 같은 날 업데이트하면 분모가 어긋나기 때문이며, 버전 비교는 작업 결과·속도에만 씁니다. 자정을 넘긴 작업은 시작이 전날, 결과가 다음 날에 기록되므로 당일 성공 수를 당일 시작 수로 나누지 않습니다.

### 핵심 결과 (D)

| 코드 | 실제 조건 |
|---|---|
| `tasks_shown` | 사용자가 연 할 일·일정 목록 조회 성공 결과가 패널에 표시됨 |
| `course_items_shown` | 선택한 과목의 과제·녹화·자료 목록 조회 성공 결과가 표시됨 (자동으로 도는 과목 목록 자체는 제외) |
| `recording_opened`, `document_opened` | 녹화 강의·자료 LMS 탭이 실제로 열림 |
| `document_downloaded` | Chrome 다운로드가 `complete`이고 파일 형식이 기대와 일치 |
| `captions_exported`, `ai_captions_exported` | 자막 TXT·JSON 두 다운로드 요청이 모두 Chrome에 수락됨(파일 쓰기 완료 관측은 아님) |
| `playback_started` | 순차 재생 시작 요청이 재생 런타임에서 성공(영상 재생 완료·이수 인정 아님) |

### 작업 (E·F)

모든 작업은 패널이 시작할 때 로컬 핸들 하나를 만들고 최종 결과를 **한 번만** 기록합니다. 핸들(작업 ID 역할)은 패널 밖으로 나가지 않습니다. 통계가 꺼진 상태에서 시작한 작업은 나중에 켜도 기록하지 않습니다. "무결과"는 실패로 바꾸지 않고 비워 둡니다.

| 작업 | trigger | 시작 | 성공 | 실패 / 시간초과 | 사용자 취소 | 무결과(미기록) |
|---|---|---|---|---|---|---|
| `courses_load`, `course_items_load`, `tasks_load` | user | 조회 요청 | 결과 success | 고정 오류 코드 / `TIMEOUT` | — | 더 새 조회로 대체 |
| `recording_open`, `document_open` | user | 열기 클릭(중복 클릭 제외) | 탭 열림 | 코드, 대상 탭 없음 `RELOAD_TAB` | — | 목록이 바뀜 |
| `document_download` | user | 파일별 다운로드 요청(일괄 다운로드는 파일 수만큼) | Chrome 완료 + 형식 일치 | 요청 오류 코드, `INTERRUPTED`, `MIME_MISMATCH`, `RATE_LIMITED`/`BUSY` | 대기 중 취소된 파일은 시작 전이라 작업 아님 | 브라우저 결과 전 패널 종료·목록 초기화 |
| `captions_detect` | user | 감지 클릭 | 자막 발견 | `NO_CAPTIONS` 등 / `TIMEOUT` | — | 다시 감지로 대체 |
| `captions_export`, `ai_captions_export` | user | 저장 클릭 | 두 파일 요청 수락 | `PARTIAL`, `DOWNLOAD_FAILED` | — | 만료·대체 |
| `ai_captions_generate` | user | 생성 확인 | 자막 수신 | 고정 코드(`PERMISSION`, `UPLOAD`, `SERVER`, `AUTH`, `TOO_LARGE`, `EXPIRED`, …) / `TIMEOUT` | 취소 버튼, 서버 측 취소 | 강의 탭 이동·닫힘, 패널 종료 후 복원된 작업 |
| `ai_handoff` | user | ChatGPT 질문 클릭 | 질문 복사 + 탭 열림 | `COPY_FAILED`, `TAB_OPEN_FAILED` | — | 과목 변경 |
| `playback_start` | user | 재생 시작 | 런타임 성공 | 재생 오류 → `PLAYBACK`/공통 코드 | — | 패널 종료 |
| `playback_refresh` | user(버튼) / auto(패널 열림) | 갱신 요청 | 성공 | 코드 | — | |

기본 제품 보고서는 `trigger=user`만 봅니다. 내부 HTTP 재시도(예: 자막 업로드 재시도, 수집 서버 재전송)는 논리 작업 수에 영향을 주지 않습니다. 처리시간 구간: `lt1s`, `1to3s`, `3to10s`, `10to30s`, `30to60s`, `1to3m`, `3to10m`, `10to30m`, `30to120m`, `ge120m`. 서로 다른 작업의 처리시간을 한 평균으로 섞지 않습니다.

## 4. 기기 안 집계와 전송 정책 (`runtime.ts`)

- **단일 writer**: background 서비스 워커의 직렬 lane 하나가 설정·하루 플래그·미전송 delta·큐를 모두 읽고 씁니다. 여러 패널의 신호, 봉인, 전송 결과 반영이 섞이지 않습니다. 네트워크 요청은 lane 밖에서 하고 결과만 lane 안에서 반영합니다.
- **원자적 기록**: 하루 첫 활성·서비스 사용·핵심 성공 플래그와 카운터 증가는 `unidock.analytics-counters.v1` 한 키에 한 번에 씁니다.
- **봉인(seal)**: 미전송 delta를 불변 보고서(일회성 `report_id`, 원래 활동 날짜, 그 시점의 확장 버전)로 옮기고 delta를 지우는 일을 같은 쓰기에서 처리합니다. 유실·이중 합산이 없고, 하루 중복 방지 플래그는 지우지 않습니다.
- **빈도**: 첫 활동 1분 뒤, 이후 활동 중 최소 10분 간격. 날짜나 버전이 바뀐 delta는 다음 깨어남에 즉시 봉인합니다. `chrome.alarms`(재생 빌드에 이미 있는 권한)가 멈춘 워커를 깨우고, 워커 시작 때마다 남은 큐를 전송합니다. 패널 종료나 다음 날 재실행만 기다리지 않습니다.
- **재전송**: 저장한 바이트 그대로 같은 `report_id`로 보냅니다. 2xx는 완료, 400/413/422는 폐기, 그 외·오프라인은 1분×2ⁿ(최대 6시간) 뒤 재시도.
- **상한**: 큐 30개(가득 차면 새 delta는 봉인하지 않고 카운터로 계속 누적), 재시도 12회, 보존 7일(서버도 7일 넘은 날짜는 `expired`로 거절. 오래된 데이터를 오늘로 바꾸지 않음), 카운터 필드 100,000(가까워지면 새 보고서로 분리), 신호 분당 600개.
- **동시성**: 봉인과 신호가 동시에 와도 lane 순서로 처리되며, 테스트에서 40개 신호와 반복 봉인을 섞어도 합계가 정확히 맞음을 확인합니다.

## 5. 기본 ON·OFF·마이그레이션 (`unidock.analytics.v2`)

| 상황 | 결과 |
|---|---|
| 신규 설치(`onInstalled: install`) | ON + 첫 실행 안내 대기. 패널이 안내를 표시한 뒤부터 집계 |
| 업데이트, 기존 PostHog 거절(`enabled:false`) | OFF 유지 |
| 업데이트, 기존 PostHog 동의 또는 미선택 | ON + "방식이 바뀌었습니다" 변경 안내 대기. 안내 표시 후부터 집계. 미선택 사용자를 신규 설치로 분류하지 않음 |
| 모든 업데이트 | 기존 PostHog 설치 UUID 키 `unidock.analytics.v1` 삭제. PostHog 미전송 데이터는 없었으며 GA4로 소급 이전하지 않음 |
| OFF | 즉시 capture 중단, 진행 중 전송 abort, 미전송 delta·큐 삭제. OFF 기간 활동은 누적하지 않음 |
| 같은 날 OFF→ON 반복 | 하루 플래그가 남아 활성·서비스 사용 설치가 다시 늘지 않음 |
| 여러 패널 | 설정 키 변경을 `storage.onChanged`로 받아 즉시 멈추고 다시 읽음 |
| 로컬 데이터 모두 삭제 | 미전송 통계 삭제. ON/OFF 선택과 오늘 플래그는 보존(OFF가 기본 ON으로 되살아나지 않음) |
| 개발 빌드·수집 서버 미설정 빌드 | "이 빌드는 통계를 보내지 않습니다" |

OFF는 이미 전체 합계에 더해진 통계를 지우지 않습니다. 합계는 설치별로 구분되지 않기 때문입니다. 안내 문구 위치: 첫 실행·변경 안내(패널 상단), 설정 → 사용 통계, 개인정보처리방침, 스토어 문안.

## 6. 수집 서버 정책 (`server/stats/`)

- `POST /v1/reports`만 공개. 허용 Origin(확장 ID), `text/plain`/`application/json`, 8 KB 이하, `isDailyReport` 엄격 검증(닫힌 키·코드, 정수 범위, 구간 합 = 표본 수, 오류 합 = 실패 + 시간초과). 임의 문자열·임의 GA 이벤트를 받지 않습니다.
- `report_id` 마커 + 요청별 nonce를 쓰는 D1 batch(트랜잭션) 하나로 중복 제거와 합계 가산을 원자적으로 처리합니다. 같은 `report_id`를 다시 보내면 `duplicate`이고 합계는 변하지 않습니다.
- 보관: 날짜별 전체 합계(`totals`), GA로 넘긴 양(`exported`), 10일짜리 `report_id` 마커, 90일 집계 export 로그, 메타 시각. 개별 설치의 일별 이력·요청 본문·IP·헤더·쿠키·referer는 저장하지 않습니다.
- 운영 Worker는 Workers Logs·Logpush·Tail을 끕니다([배포 안내](../server/stats/README.md)).

## 7. GA4 export 정책

- 대상: **집계 전용 GA4 property + Web stream**, reporting time zone **Asia/Seoul**. 개발·스테이징 이벤트는 별도 Worker·D1·테스트 property로만 보냅니다.
- 매시 오늘 포함 4일(오늘−3 ~ 오늘)에 대해 `totals − exported` delta만 이벤트로 만듭니다. 전 기간 누적 snapshot을 반복 전송하지 않습니다.
- `timestamp_micros`: 그 Seoul 날짜 안이면서 지금부터 71시간 이내인 시각(GA4 72시간 소급 제한). 그런 시각이 없으면 보내지 않고 상태 API의 `exportable:false`로 남깁니다. 오래된 delta를 오늘로 보내지 않습니다.
- `client_id`: 요청마다 새로 만드는 합성 값(저장·재사용 안 함). 설치·사용자와 무관합니다. `user_id`, `user_properties`, `session_id`, `engagement_time_msec`, IP·UA·위치 override를 보내지 않습니다. 이것은 GA4의 공식 익명 모드가 아닙니다.
- **수집 API의 중복 제거 ≠ GA 정확히 한 번.** GA MP는 중복 제거를 하지 않으므로 export는 *최대 한 번*입니다: 보내기 전에 `exported`를 올리고, 429/5xx 응답이면 되돌려 다음 실행에서 재전송, 그 외 4xx는 되돌리고 중단, 응답 유실·시간초과는 `unknown`으로 기록하고 재전송하지 않습니다(이중 집계보다 누락을 택함). 15분 넘게 `sending`인 기록은 `unknown`. **D1 합계가 기준 원장**입니다.

이벤트(필요한 차원만 event-scoped로 부착, 숫자는 custom metric):

| 이벤트 | 차원 | 측정항목 |
|---|---|---|
| `ud_activity_agg` | — | `ud_active_installs`, `ud_core_installs` |
| `ud_core_agg` | `ud_core_result` | `ud_core_results` |
| `ud_service_agg` | `ud_service` | `ud_service_entries`, `ud_service_installs` |
| `ud_operation_agg` | `ud_operation`, `ud_trigger`, `ud_extension_version` | `ud_op_started`, `ud_op_success`, `ud_op_failure`, `ud_op_timeout`, `ud_op_cancel`, `ud_duration_ms_sum`, `ud_duration_count` |
| `ud_error_agg` | 위 3개 + `ud_error_code` | `ud_op_errors` |
| `ud_latency_agg` | 위 3개 + `ud_latency_bucket` | `ud_latency_count` |
| `ud_pipeline_agg` | `ud_pipeline_status` | `ud_pipeline_reports` |

사용 200회를 담은 이벤트 1건은 Event count가 1이지만 `customEvent:ud_service_entries` 합은 200입니다. 보고서는 항상 custom metric 합계를 쓰고 `eventCount`/`countCustomEvent`로 대체하지 않습니다.

### Measurement Protocol 단독 전송의 제약

- GA4 기본 **Users·Sessions·Engagement·Retention·Realtime·사용자 기반 전환율은 의미가 없습니다**(합성 client_id, 세션 없음). 제품 지표로 쓰지 않습니다. Realtime을 채우려고 가짜 세션을 만들지 않습니다.
- 운영 엔드포인트 `/mp/collect`는 형식이 틀려도 2xx를 돌려줍니다. **HTTP 2xx는 반영 증거가 아닙니다.** 형식 검증은 `/debug/mp/collect`(관리 API `?validate=1`), 실제 반영은 처리 후(보통 24~48시간) Data API 합계로 확인합니다.
- custom definitions는 **등록 후 수신된 이벤트에만** 채워집니다. 첫 export 전에 등록하세요.
- 세션 기반 차원(소스·매체 등)은 `(not set)`이 될 수 있습니다. 사용하지 않습니다.

## 8. GA4 설정 순서 (권한이 있는 운영자)

1. GA4에서 집계 전용 **테스트 property**와 **운영 property**를 따로 만들고 각각 **Web data stream** 하나를 만듭니다(사이트 URL은 수집 서버 origin 등 실제 소유 주소. 웹 태그는 설치하지 않음). Enhanced measurement는 꺼 둡니다.
2. Admin → Property details: reporting time zone **Asia/Seoul**(또는 `npm run ga4:setup -- --property <id> --apply --set-timezone`).
3. Admin → Data collection and modification: Google signals 끔, 데이터 보관 기간 **2개월**.
4. Admin → Data streams → 해당 stream → Measurement Protocol API secrets에서 secret 생성 → 수집 서버 `wrangler secret put GA_API_SECRET`. measurement ID(`G-…`)는 Worker 변수 `GA_MEASUREMENT_ID`. 확장에는 넣지 않습니다.
5. custom definitions 등록: `npm run ga4:setup`(표 출력) → `GA_ADMIN_TOKEN=… npm run ga4:setup -- --property <id> --apply`. 또는 Admin → Data display → Custom definitions에서 위 표의 차원 8개(Event scope)와 측정항목 15개(Event scope, Standard 단위)를 같은 parameter 이름으로 직접 만듭니다.
6. 테스트 property로 연결한 스테이징 Worker에서 `POST /v1/admin/export?validate=1` → `validationMessages`가 비어 있는지 확인(형식 검증).
7. 실제 export 후 24~48시간 뒤 `npm run ga4:report -- --source ga`와 `--compare`로 custom metric 합계가 원장과 일치하는지 확인(실제 반영 검증). 확인 전에는 운영 property로 전환하지 않습니다.

## 9. 보고서 구성

### GA4 Explorations (Explore → Free form)

공통: 기간 선택, **Event name 정확히 일치** 필터, 행 `Date`, 값은 아래 custom metric(합계).

1. **전체 현황**: 필터 `ud_activity_agg` / 값 `UD active installs`, `UD core installs` / 시각화 선 그래프. 핵심 가치 도달률은 Admin → Data display → Calculated metrics에서 `{ud_core_installs} / {ud_active_installs}` 계산 측정항목을 만들어 같은 표에 추가합니다(행별 합계에 대해 계산되므로 기간 합계 행도 Σ/Σ). 완료된 핵심 결과 수: 필터 `ud_core_agg`, 행 `UD core result`, 값 `UD core results`.
2. **기능 분석**: 필터 `ud_service_agg` + `UD service`가 `settings`가 아님 / 행 `Date`, 열 `UD service` / 값 `UD service entries`, `UD service installs`. 도달률은 같은 날짜의 활성 설치(1번 표)로 나눕니다. 서로 다른 이벤트의 측정항목을 한 표에서 나누면 필터가 섞이므로 비율은 Looker Studio 혼합 데이터나 `ga4:report`로 계산합니다.
3. **작업 품질**: 필터 `ud_operation_agg` + `UD trigger` = `user` / 행 `UD operation`(버전 비교 시 `UD extension version` 추가) / 값 started·success·failure·timeout·cancel·duration sum·duration samples. 성공률·취소율·가중 평균은 계산 측정항목(예: `{ud_op_success} / ({ud_op_success} + {ud_op_failure} + {ud_op_timeout})`, `{ud_duration_ms_sum} / {ud_duration_count}`)으로 만듭니다(표준 property는 계산 측정항목 수에 제한이 있으니 필요한 것만). 오류 분포: 필터 `ud_error_agg`, 행 `UD operation`·`UD error code`, 값 `UD operation errors`. 지연 분포: 필터 `ud_latency_agg`, 행 `UD latency bucket`, 값 `UD latency bucket count`. 버전 비교 표에는 항상 표본 수(`UD duration samples`, 결과 합)와 기간을 함께 둡니다.
4. **데이터 상태**: 필터 `ud_pipeline_agg`, 행 `Date`·`UD pipeline status`, 값 `UD pipeline reports`.

### Looker Studio (선택)

GA4 커넥터로 위 property를 연결합니다.

- **100% 누적 막대**: 차트 "100% stacked column chart", 측정기준 `Date`, 세부 측정기준 `UD service`, 측정항목 `UD service entries`, 필터 Event name = `ud_service_agg` AND `UD service` ≠ `settings`. 막대마다 그 날짜 합계로 정규화되므로 분모가 날짜별입니다(전체 기간 합계로 나누지 않음).
- 도달률·핵심 가치 도달률: `ud_activity_agg`와 `ud_service_agg` 차트를 `Date` 기준 **데이터 혼합**한 뒤 `SUM(UD service installs) / SUM(UD active installs)` 계산 필드.
- Looker Studio에는 7일 창 이동평균과 버킷 기반 백분위 기본 기능이 없으므로 7일 이동평균·전주 같은 요일·근사 p95는 `npm run ga4:report` 결과를 사용합니다.

### Data API (재현 가능한 기준 보고서)

```bash
GA_PROPERTY_ID=<숫자 id> \
GA_DATA_TOKEN=$(gcloud auth print-access-token --scopes=https://www.googleapis.com/auth/analytics.readonly) \
npm run ga4:report -- --source ga --from 2026-11-01 --to 2026-11-14
```

질의 예(`runReportBody`가 만드는 것과 같음):

```json
POST https://analyticsdata.googleapis.com/v1beta/properties/<id>:runReport
{
  "dateRanges": [{ "startDate": "2026-11-01", "endDate": "2026-11-14" }],
  "dimensions": [{ "name": "date" }, { "name": "customEvent:ud_service" }],
  "metrics": [{ "name": "customEvent:ud_service_entries" }, { "name": "customEvent:ud_service_installs" }],
  "dimensionFilter": { "filter": { "fieldName": "eventName", "stringFilter": { "matchType": "EXACT", "value": "ud_service_agg" } } }
}
```

### 데이터 상태와 원장 비교

- `GET /v1/admin/status`(Bearer `ADMIN_TOKEN`): 최종 수신·export 시각, 최근 14일 수신 상태(accepted/accepted_late/duplicate/invalid/expired), 30일 export 결과(sent/failed/rejected/unknown), 날짜별 미전송 delta와 `exportable`.
- `npm run ga4:report -- --compare`: 원장(`/v1/admin/totals`)과 GA4 합계를 날짜·지표·차원별로 비교. 정상적인 차이는 GA 처리 지연, `unknown` export, 72시간 창을 넘긴 날짜뿐입니다. 수집 장애(수신 0, invalid 급증, export failed)는 이용량 감소로 해석하지 않습니다.

## 10. 검증

자동 테스트(`npm test`):

- `tests/analytics.test.ts`: 신규 설치 안내 전 미집계, PostHog 설정 마이그레이션·UUID 삭제, 여러 번 전송해도 활성·서비스 사용 설치 하루 1회, 핵심 ≤ 활성, 자정 경계, 워커 재시작 후 동일 바이트 재전송, 동시 capture/flush 무손실, 재시도·폐기·상한, OFF 즉시 중단·같은 날 ON 재집계 없음, 삭제 후 OFF 유지, 작업 결과 1회, 금지 값 거부, 7일 초과 폐기.
- `tests/analytics-client.test.ts`: 작업 최종 결과 1회·OFF 중 시작 작업 미소급, 동적 오류 → 고정 코드, OFF 즉시 중단·다른 패널 동기화, visible일 때만 핵심 결과, StrictMode·재렌더·하위 화면·재선택·설정 왕복에서 진입 1회.
- `tests/analytics-metrics.test.ts`: 아래 가상 데이터 기대값, GA 왕복(원장 → 이벤트 → Data API 행 → 같은 합계), `customEvent:` 사용·`eventCount` 미사용, Seoul 날짜, 72시간 창.
- `tests/stats-server.test.ts`: 수신·중복(순차·동시)·검증 실패·만료·Origin·크기, export delta·재전송·unknown·stale·72시간, 검증 모드, 관리 인증, 정리.
- E2E `npm run test:e2e:analytics`: 실제 빌드에서 첫 실행 안내, 하루 1회 활성, 재선택 무시, 닫힌 payload, 금지 문자열 없음, 다중 패널 OFF, 삭제 후 OFF 유지.

가상 데이터 기대값(`npm run ga4:report -- --fixture`, `scripts/analytics-fixture.ts`):

| 입력 | 기대값 |
|---|---|
| 날짜1 courses 7 / tasks 3, 날짜2 2 / 8 (settings 5 별도) | 일별 비중 70/30%, 20/80%. 기간 비중 courses 9/20 = 45% |
| 활성 10, courses 사용 6, tasks 사용 5 | 도달률 60%, 50% |
| 성공 8, 실패 1, 시간초과 1, 취소 2 | 성공률 80%, 취소율 2/12 = 16.7% |
| 성공 표본 8, 합 34,000 ms, 구간 1to3s 7·10to30s 1 | 평균 4,250 ms, 근사 p95 ≤ 30,000 ms |
| 활성 10·10, 핵심 4·6 | 일별 40%, 60%, 기간 20분의 10 = 50% |
| 사용 200을 담은 집계 이벤트 1건 | `ud_service_entries` = 200 |

**검증 범위**: 위 테스트와 모의 수집 서버(`npm run stats:dev`, 모의 GA 엔드포인트)까지 확인했습니다. 실제 GA4 property에서의 MP validation, 커스텀 수치 조회, Explorations·Looker Studio 구성은 계정 권한이 필요해 아직 확인하지 않았습니다(8장 6~7단계).
