# AI 자막 서버 공개 API 계약

`public.openapi.yaml`은 확장 ↔ 자막 서버(broker) 계약의 사본입니다. 원본은 비공개 저장소 `sounmu/unidock-captions`의 `api/public.openapi.yaml`이고, worker API·운영 문서는 그쪽에만 있습니다.

- 가져온 원본 커밋: `a723e25` (unidock-captions PR #1, ADR-0010 반영)
- 확장 코드는 이 사본을 기준으로 합니다. `tests/caption-api-contract.test.ts`가 `tests/fixtures/caption-api/`의 응답 예시와 확장이 보내는 요청을 이 명세로 검증합니다.
- 명세를 바꿀 때는 원본 저장소에서 먼저 바꾸고, 이 파일을 그대로 복사한 뒤 위 커밋 해시를 갱신합니다. 이 사본만 고치지 않습니다.
- dev 단계라 `/v1` 안에서도 깨는 변경이 있을 수 있습니다(원본 ADR-0009). 그때는 명세 사본, fixture, 클라이언트를 한 PR에서 함께 바꿉니다.
