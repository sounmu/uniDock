# 클라이언트–서버 버전 계약

서버 저장소 `sounmu/unidock-server`가 계약 원본을 관리합니다.
`server-contract.lock.json`은 `contracts/releases/1.0.0/manifest.json`의 정확한
SHA-256을 고정하고, 사본 `server-contract.manifest.json`은 자막 OpenAPI,
통계 JSON Schema, 통계 wire fixture 각각의 SHA-256을 고정합니다.
비공개 서버 저장소에 접근하지 못하는 확장 CI도 사본을 오프라인 검증합니다.

앱 릴리스 번호(`package.json.version`), 계약 묶음 버전(`1.0.0`),
API 경로(`/v1`), 자막 `schema_version: 1`, 통계 `schema: 1`은 서로 다른 값입니다.
확장과 서버 릴리스 번호를 맞추거나 매 요청 전에 버전 확인 API를 호출하지 않습니다.
지원하지 않는 자막 스키마는 클라이언트가 기존 응답 오류 경로로 거부합니다.

## 검증

```sh
npm run server-contract:check
npm run server-contract:check -- --server ../unidock-server
npx vitest run tests/caption-api-contract.test.ts tests/analytics-report-contract.test.ts
```

첫 명령은 로컬 사본과 고정 해시를, 두 번째 명령은 서버의 원본 묶음까지 검사합니다.
`npm run check`, 확장 CI, 릴리스 패키징도 핀 검사를 실행합니다.
자막 계약 테스트는 확장의 실제 요청과 응답 파서를, 통계 테스트는 실제 보고서
파서와 집계 결과를 검증합니다. JSON Schema는 통계 구조와 범위를 설명하며,
합계 관계·중복 키 처리·숫자 표기·집계 의미는 wire fixture와 실제 파서가 검증합니다.
해시 일치는 파일 출처의 동일성 검사이지 동작 호환성의 증명이 아닙니다.
서버 CI는 고정된 과거 확장 소스에 실제 후보 서버 응답을 전달하는 검사를 별도로 실행합니다.

## 변경과 배포

1. 서버에서 새 계약을 추가하고 기존 지원 계약 검사를 통과시킵니다.
2. 기존 클라이언트도 계속 지원하는 서버를 먼저 배포합니다.
3. 검증된 묶음을 가져와 사본, manifest, lock을 함께 갱신하고 확장을 검증·출시합니다.

기존 버전의 artifact나 기대 fixture를 덮어써서 호환성 실패를 없애면 안 됩니다.
기존 경로의 필드·제약·enum·상태 코드·인증·헤더 변경은 서버의 보수적 호환성
검사에서 막습니다. 필드나 enum 추가도 소비자의 닫힌 파서에서는 깨지는 변경입니다.
새 계약이 필요하면 명시적인 새 경로나 payload 버전을 도입하고 기존 계약을 유지합니다.
지원 종료는 별도 검토 대상이며 계약 업데이트에 끼워 넣지 않습니다.

초기 `1.0.0`은 manifest 해시로 식별하는 콘텐츠 고정 묶음입니다.
아직 이 artifact를 포함하지 않는 과거 서버 커밋을 출처 커밋으로 기록하지 않습니다.
이전 사본 이후 서버에 추가된 `NO_WORKER_AVAILABLE`과 transcript provenance도
이번 기준선에 포함됩니다. worker API는 이 확장용 계약 범위 밖입니다.
