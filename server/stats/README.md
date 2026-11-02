# uniDock 통계 수집기 (Cloudflare Worker + D1)

확장 프로그램이 보내는 하루 단위 증분 리포트를 받아 전역 날짜별 합계로 누적하고, 아직 내보내지 않은 증분을 GA4 Measurement Protocol(MP)로 보냅니다. 로그인, 웨어하우스, 대시보드는 없습니다.

## 구조

```
확장 --POST /v1/reports--> Worker --(원자적 batch)--> D1 totals
                             cron(매시 17분) --증분--> GA4 MP (/mp/collect)
```

- `src/worker.ts` 진입점, `src/ledger.ts` 수집/중복 제거, `src/export.ts` GA 내보내기, `src/admin.ts` 관리 API.
- 계약(검증, 행 변환, GA 이벤트 변환)은 `src/analytics/report.ts`, `src/analytics/ga4.ts`를 그대로 가져다 씁니다.
- D1에는 합계(`totals`), 내보낸 양(`exported`), 10일짜리 `report_ids`, 집계용 `export_log`, `meta`만 저장합니다. 요청 본문, IP, User-Agent, 쿠키, Referer, 설치별 이력은 읽지도 저장하지도 않고, Worker 코드는 아무것도 로그하지 않습니다.
- GA에는 요청마다 새로 만든 합성 `client_id`만 쓰며 `user_id`, 세션, 기기 정보는 보내지 않습니다.

## 환경 변수

| 이름 | 종류 | 설명 |
|------|------|------|
| `DB` | D1 바인딩 | 수집기 데이터베이스 |
| `GA_MEASUREMENT_ID` | var | `G-XXXXXXXXXX` |
| `GA_API_SECRET` | secret | MP API secret. 응답/DB/오류에 나타나지 않음 |
| `GA_ENDPOINT` | var | 기본 `https://www.google-analytics.com`, EU는 `https://region1.google-analytics.com` |
| `ALLOWED_ORIGINS` | var | 쉼표로 구분한 정확한 Origin 목록, 예: `chrome-extension://<id>` |
| `ADMIN_TOKEN` | secret | 관리 API Bearer 토큰. 비어 있으면 관리 경로 전체가 404 |
| `EXPORT_ENABLED` | var | `1`일 때만 cron이 GA로 전송. 그 외에는 GA 트래픽 없음 |

## 로컬 실행

```bash
node scripts/stats-dev-server.mjs            # 메모리 DB, 127.0.0.1:8787
node scripts/stats-dev-server.mjs --db dev.sqlite --port 8788
```

Node 22.18+/24+ (타입 스트리핑 필요)에서 동작합니다. 개발 서버는 `/mock-ga/mp/collect`, `/mock-ga/debug/mp/collect`를 내장하며 GA는 이쪽으로만 나갑니다. 허용 Origin은 `chrome-extension://dev`와 서버 자신이고(`DEV_ALLOWED_ORIGINS`로 변경), 관리 토큰은 `dev-admin`(`DEV_ADMIN_TOKEN`)입니다. `GET /mock-ga/payloads`로 받은 페이로드를 볼 수 있습니다.

```bash
curl -X POST http://127.0.0.1:8787/v1/reports -H 'Origin: chrome-extension://dev' \
  -H 'Content-Type: text/plain;charset=UTF-8' --data @report.json
curl -X POST http://127.0.0.1:8787/v1/admin/export -H 'Authorization: Bearer dev-admin'
```

테스트: `npx vitest run tests/stats-server.test.ts`

## 배포

`server/stats`에서 실행합니다.

```bash
cp wrangler.toml.example wrangler.toml            # 값 채우기 (wrangler.toml은 커밋 금지)
npx wrangler@4 d1 create unidock-stats            # 출력된 database_id를 wrangler.toml에 입력
npx wrangler@4 d1 execute unidock-stats --file schema.sql --remote
npx wrangler@4 secret put GA_API_SECRET
npx wrangler@4 secret put ADMIN_TOKEN
npx wrangler@4 deploy
```

- 라우트/커스텀 도메인: Cloudflare 대시보드 또는 `wrangler.toml`의 `routes`로 전용 호스트(예: `stats.example.com/*`)를 연결하고 `workers_dev = false`를 유지합니다.
- 처음에는 `EXPORT_ENABLED="0"`으로 두고 아래 validate로 GA 응답을 확인한 뒤 `"1"`로 바꿔 재배포합니다.
- D1 쿼리 한도 때문에 리포트 한 건은 4개 구문의 batch로 처리합니다(행 수와 무관).

### 스테이징과 프로덕션

스테이징과 프로덕션은 Worker, D1, GA4 속성을 각각 따로 둡니다(`--env` 또는 별도 `wrangler.toml`). 스테이징에는 GA4 테스트 속성의 Measurement ID와 secret만 넣습니다. 개발/테스트 이벤트가 프로덕션 속성으로 가면 안 됩니다. 확장 개발 빌드는 스테이징 도메인만 가리키게 합니다.

## Cloudflare 로그 점검

프로덕션에서는 Workers Logs, Logpush, `wrangler tail`을 사용하지 않습니다(`observability.enabled = false`, `logpush = false`). 도메인 분석에서 IP가 남는 "Request logging"류 기능도 켜지 않습니다. 배포 후 대시보드 설정에서 확인하세요.

## WAF 속도 제한 권장

`POST /v1/reports`에 IP당 분당 몇 건(예: 10건/분) 이하 제한을 Cloudflare WAF Rate limiting 규칙으로 겁니다. 한도를 넘으면 Block. 응답을 늘리지 않으려면 로그 없이 차단만 설정합니다.

## 관리 API

모든 요청에 `Authorization: Bearer $ADMIN_TOKEN`이 필요합니다.

```bash
H="Authorization: Bearer $ADMIN_TOKEN"; B=https://stats.example.com
curl -H "$H" $B/v1/admin/status
curl -H "$H" "$B/v1/admin/totals?from=2026-11-01&to=2026-11-07"      # 최대 92일
curl -X POST -H "$H" "$B/v1/admin/export?validate=1"                  # /debug/mp/collect, DB 변경 없음
curl -X POST -H "$H" $B/v1/admin/export                               # 지금 내보내기
```

`status`의 `unexported[]`에서 `exportable:false`이고 `value_sum > 0`이면 GA의 72시간 한도를 넘겨 더 이상 보낼 수 없는 날짜입니다.

## GA 내보내기 정책 (최대 한 번)

D1 합계가 원장입니다. 청크를 보내기 **전에** `exported`에 증분을 더하고 `export_log`에 `sending`을 기록합니다.

| 결과 | 처리 |
|------|------|
| 2xx | `sent` |
| 429 / 5xx | `exported` 되돌림, `failed`, 이번 실행 중단 (다음 실행이 재전송) |
| 그 외 non-2xx | 되돌림, `rejected`, 중단 (설정/페이로드 점검) |
| 네트워크/타임아웃 | `unknown`, 되돌리지 않음, 같은 청크는 다시 보내지 않음 |
| 15분 넘게 `sending` | `unknown`으로 표시 (증분은 이미 보낸 것으로 간주) |

내보내기는 meta의 5분 lease로 cron과 수동 실행이 겹치지 않게 합니다.

### 재조정 절차

1. `GET /v1/admin/status`에서 `exports.unknown`과 `unexported`를 확인합니다.
2. `GET /v1/admin/totals`의 합계와 GA 보고서(Seoul 날짜 기준)를 비교합니다. GA가 적으면 `unknown` 청크가 실제로 유실된 것입니다.
3. 유실은 자동으로 다시 보내지 않습니다. 필요하면 해당 날짜 `exported` 행을 수동으로 낮춰(D1 콘솔) 다음 실행에서 재전송하되, 이미 처리됐을 가능성(중복 집계)을 감수해야 합니다.
4. `rejected`가 반복되면 `?validate=1`의 `validationMessages`로 원인을 확인합니다.
