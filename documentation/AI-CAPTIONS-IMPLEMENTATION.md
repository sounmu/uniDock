# AI 자막 생성 구현 브리프

- 작성일: 2026-10-22
- 대상 독자: 이 기능을 구현하는 에이전트와 리뷰어
- 근거 문서: `documentation/FEATURE-RESEARCH-2026-10.md` 4장 (특히 4.2, 4.2.1, 4.2.2, 4.4~4.7)
- 읽는 순서: **이 브리프 → 리서치 문서 4장 → `AGENTS.md` → `src/AGENTS.md`**

이 문서는 작업 지시다. 리서치 문서는 "왜"를 설명하고, 이 문서는 "무엇을 어떤 순서로, 어디까지"를 정한다. 두 문서가 충돌하면 이 문서를 따르되 충돌 지점을 PR 설명에 적는다. 리서치 문서 4.2.1·4.2.2를 위반하는 구현은 범위에 맞아도 거부된다.

## 0. 확정된 사실과 결정

구현 중에 다시 조사하지 않는다. 바뀌었다고 의심되면 멈추고 보고한다.

| 항목 | 확정 내용 |
| --- | --- |
| 미디어 형식 | KU 플레이어(`kucom.korea.ac.kr/em/{id}`, `contentType: "upf"`)는 progressive MP4 하나를 `uniPlayerConfig._contentPlayingInfoData.storyList[*].mainMediaList.list[*].desktopMediaUri`로 제공한다. 표본 1건은 약 463 MB, 약 66분 |
| 미디어 호스트 | `https://korea-cms-object.cdn.gov-ntruss.com/contents7/kruniv1001/{id}/contents/media_files/*.mp4` |
| 접근 조건 | **Referer hotlink 제한만** 있다. `Referer: https://kucom.korea.ac.kr/`를 붙이면 쿠키·서명 없이 206. CORS 헤더는 없다 |
| 막힌 경로 | 페이지·content script `fetch`(CORS), background `fetch`(Referer 없음 → 403, release CSP → 차단), kucom 같은 출처 경로(HTML 반환), `contents7_pseudo`(503), `captureStream`(cross-origin 무음) |
| 취득 방식 | 확장 background/sidepanel에서 `declarativeNetRequestWithHostAccess` **세션 규칙**으로 자기 요청에만 Referer를 붙여 스트리밍으로 읽는다 |
| 전송 형식 | 영상은 버리고 **오디오 트랙만** 보낸다. 1순위 AAC 재다중화(`.m4a`, 재인코딩 없음), 2순위 WebCodecs → Opus. MP3는 쓰지 않는다 |
| 배포 | `UNIDOCK_AI_CAPTIONS=1` 빌드에서만 컴파일된다. release 패키징은 이 빌드를 거부한다. 스토어 제출은 이 브리프 범위 밖이다 |
| 추론 | 운영자 Mac mini M4 16GB. 1순위 Whisper `large-v3-turbo`. 엔진은 `whisper.cpp` 우선(2026-10-24 운영자 결정, Python 런타임 없음), `mlx-whisper`는 PoC 비교용. 비교 후보 `large-v3`, Qwen3-ASR-1.7B, 한국어 fine-tune |
| 서버 | 3계층: 오라클 broker(Go, PostgreSQL) + Mac mini worker(Go 감독 프로세스 + `whisper.cpp` 자식 프로세스) + Cloudflare R2(자막·백업). 다른 사용자도 쓰는 구성이다. 배치와 흐름은 아래 "배치와 데이터 흐름"이 기준이다. 음원은 성공 즉시 삭제, 자막은 최초 생성 후 6개월 |
| 인증·quota | Google OAuth 로그인 후에만 사용. 사용자당 주 7회(KST 월요일 초기화). 같은 음원은 공유 캐시로 제공. API 계약은 `unidock-captions/api/public.openapi.yaml`, 결정 근거는 같은 저장소 `docs/adr/` |

### 배치와 데이터 흐름 (2026-10-24 확정)

| 구성 요소 | 위치 | 역할 | 갖는 자격증명 |
| --- | --- | --- | --- |
| 확장 | 사용자 Chrome | Google 로그인, CDN에서 음원 트랙만 분리, broker로 업로드, 결과 표시 | broker 세션 토큰 |
| broker | 오라클 인스턴스 | 공개 API, 업로드 spool, 검증, 작업·lease 관리, 결과 제공 | DB 비밀번호, R2 버킷 토큰 |
| PostgreSQL | broker와 같은 인스턴스 | 작업·lease·attempt·사용자·자막 메타데이터·만료·삭제 대기열. **유일한 진실 원천** | — |
| R2 | Cloudflare | 자막 JSON, DB 백업. 비공개 버킷 | — |
| worker | Mac mini | lease 수령, 음원 수신, 추론, 결과 제출 | 워커 토큰 (사용자 토큰과 별개) |

```text
(1) 확장 → broker   POST /v1/transcription-jobs (Idempotency-Key = 강의별 고정 키)
                    같은 키의 기존 작업이 있으면 그 작업을 반환 → (2)를 건너뜀   → awaiting_upload
(2) 확장 → broker   음원 트랙 업로드 → 오라클 로컬 spool 파일에 offset 순서대로 기록
(3) broker          업로드 완료 → SHA-256 계산 → ffprobe(로컬 파일) 검증       → queued
                    (같은 캐시 키의 성공 자막이 있으면 추론 없이 연결          → succeeded)
(4) worker → broker [tailnet] lease 요청 → {job_id, attempt, lease_expires_at}  → running
(5) worker → broker [tailnet] 음원 GET → Mac 작업 디렉터리 → whisper.cpp → 시간축 검증
                    처리 중 heartbeat로 lease 연장
(6) worker → broker [tailnet] 결과 JSON 제출(job_id, attempt)
                    → broker 스키마·시간축 검증 → R2 저장 → PostgreSQL 완료 커밋 → succeeded
(7) broker          spool 음원 삭제. worker는 제출 ack를 받은 뒤 로컬 음원 삭제
(8) 확장 → broker   GET 상태 / GET /v1/transcripts/{id} → 소유·만료 확인 후 R2에서 읽어 응답
```

불변 조건:

- **CDN에 요청하는 것은 확장뿐이다.** 미디어 URL, LMS URL, 과목 ID, 강의 제목은 브라우저 밖으로 나가지 않는다. broker와 worker는 URL을 받지도, 외부에서 미디어를 받아 오지도 않는다.
- **확장이 연결하는 서버 쪽 출처는 broker 하나다.** `connect-src`에는 음성을 받는 CDN과 broker origin만 추가한다. 확장은 R2나 worker에 직접 연결하지 않는다.
- **Mac은 inbound를 받지 않는다.** 모든 연결은 worker가 tailnet을 통해 broker로 먼저 연다. 공인 인터넷에 열린 Mac 포트는 없다.
- **음원은 R2에 저장하지 않는다.** 사본은 오라클 spool 파일과 Mac 작업 디렉터리 두 곳뿐이다. 성공 즉시 삭제와 실패 시 24시간 보관은 두 사본 모두에 적용한다.
- **worker와 확장은 R2 자격증명을 갖지 않는다.** R2 읽기·쓰기는 broker만 한다. 결과도 broker가 검증한 뒤 저장한다.
- **캐시 키의 digest는 서버가 계산한다**(3번 단계). 클라이언트가 보낸 해시로 다른 사용자의 자막을 내주지 않는다. 업로드 전에 해시만 보고 결과를 주는 중복 제거는 별도 소유 증명(BL-01 지문 챌린지)을 갖춘 뒤에만 검토한다.
- **PostgreSQL이 기준이다.** 커밋된 행이 없는 R2 객체는 고아로 보고 정리 작업이 지운다. 삭제·만료는 DB에 먼저 tombstone을 남기고 객체를 지우며, 늦게 도착한 attempt 결과는 tombstone이나 다음 attempt를 이기지 못한다.

## 1. 단계

단계는 순서대로 진행하고, 각 단계의 완료 조건을 만족한 뒤 다음 단계로 간다. 한 단계가 한 PR일 필요는 없지만 단계를 건너뛰어 섞지 않는다.

### 1단계. Mac에서 모델 PoC (확장 코드 변경 없음)

목적: "내 Mac에서 쓸 만한 한국어 자막이 나오는가"를 수치로 답한다. 이 단계 결과가 나쁘면 2·3단계를 시작하지 않는다.

위치: **별도 저장소 `unidock-captions`** (서버·워커·PoC 스크립트). 이 저장소에는 넣지 않는다. 릴리스 allowlist·lint·notices에 영향을 주지 않기 위해서다.

할 일:

1. 사용자가 직접 확보한 음원 3~5개를 쓴다. 한국어 단독, 영어 전문용어 혼합, 음질 낮음, 긴 무음을 포함한다. 음원 파일은 저장소에 커밋하지 않는다.
2. `mlx-whisper` + `large-v3-turbo`로 전체를 돌린다. 측정: RTF(`처리 시간 / 음원 길이`), peak 메모리, cold/warm 실행 시간.
3. 같은 음원을 `whisper.cpp` `large-v3-turbo`(Core ML encoder, `--vad`)로 돌려 속도와 무음 구간 환각을 비교한다.
4. 각 음원에서 2~3분 표본의 정답 전사를 사람이 만들고 CER을 계산한다. 전문용어·숫자·의미 왜곡은 별도 메모로 남긴다.
5. 품질이 부족할 때만 `large-v3` → Qwen3-ASR-1.7B(aligner 5분 chunk 포함) → 한국어 fine-tune 순으로 추가 비교한다.
6. 선택한 엔진·모델 revision·양자화·디코딩 설정을 고정해 `poc/RESULTS.md`에 기록한다.

완료 조건:

- `poc/RESULTS.md`에 음원별 RTF, peak 메모리, CER, 환각 유무가 표로 있다.
- 선택 엔진·모델·설정이 한 줄로 확정돼 있다.
- 결과 요약을 `documentation/FEATURE-RESEARCH-2026-10.md` 4.4절 끝에 "실측" 소제목으로 추가한다 (이 저장소에서 유일하게 바뀌는 파일).

### 2단계. 서버 (별도 저장소)

목적: 확장이 업로드할 대상과, 결과를 가져올 API를 만든다. 알림은 넣지 않는다. 다중 사용자(Google OAuth), quota, 공유 캐시는 `unidock-captions`의 명세와 `docs/STATE-MACHINE.md`를 따른다.

위치: `unidock-captions` 저장소. 언어는 Go. broker(오라클)와 worker(Mac)는 별도 바이너리이며 배치는 0장 "배치와 데이터 흐름"을 따른다. worker 안에서도 `whisper.cpp`는 자식 프로세스로 실행해 **추론 실패가 worker 감독 루프와 broker를 죽이지 않게** 한다.

API: 기준은 `unidock-captions/api/public.openapi.yaml`이다. 아래 표는 요약이며, 다르면 명세를 따른다.

| API | 비고 |
| --- | --- |
| `POST /v1/transcription-jobs` | `Idempotency-Key` 헤더 필수. 본문은 `{audio_format, duration_hint_s?, language?}`. 음원 크기는 첫 PATCH의 `Upload-Length`로 선언한다. 키는 강의별 고정 값이며 실패·취소·자막 만료 시 서버가 푼다(unidock-captions ADR-0010). 클라이언트 해시는 받지 않는다(digest는 broker가 계산) |
| `HEAD`·`PATCH /v1/transcription-jobs/{id}/audio` | tus 1.0 core 재개 업로드, 8 MiB chunk. `audio/mp4` 또는 `audio/ogg`. 크기 상한 200 MB를 넘으면 413, 길이 4시간을 넘으면 `DURATION_TOO_LONG` |
| `GET /v1/auth/google/start`(창 이동), `POST /v1/auth/handoff`, `POST /v1/auth/refresh`, `GET /v1/me` | broker 콜백 Google 로그인과 1회용 연결 코드 교환, 세션 갱신, 이번 주 quota |
| `GET /v1/transcription-jobs/{id}` | `{id, state, error_code?, cancel_requested?, upload, progress?, transcript_id?, created_at, updated_at}`. 만료일은 작업이 아니라 자막에 있다 |
| `POST /v1/transcription-jobs/{id}/cancel` | |
| `GET /v1/transcripts/{id}` | 리서치 문서 4.6의 JSON 스키마. `expires_at`(최초 생성 + 6개월)은 여기와 `GET /v1/transcripts` 목록에 있다 |
| `DELETE /v1/transcripts/{id}` | 내 연결만 끊는다. 공유 자막은 만료일까지 남는다 |

규칙:

- 인증은 Google OAuth 로그인 후 broker가 발급한 세션 토큰(`Authorization: Bearer`)이다(ADR-0006). 정적 비밀을 확장 번들에 넣지 않는다. quota는 사용자당 주 7회다(ADR-0008).
- 업로드 완료 후 FFmpeg(`ffprobe`)로 코덱·채널·길이를 검증하고 나서야 `queued`로 바꾼다. MIME만 믿지 않는다. FFmpeg는 인자 배열로 호출하고 시간·메모리 제한을 건다.
- 상태는 `awaiting_upload → queued → running → succeeded | failed | cancelled`. 워커는 lease와 attempt 번호를 받고, 늦은 attempt의 결과는 버린다.
- 성공 즉시 원본 음원을 삭제한다. 실패 시 보관은 24시간으로 제한한다.
- `expires_at`은 자막 최초 생성 후 6개월이며 연장하지 않는다(ADR-0008). 만료 시 API는 404를 주고, 객체는 별도 정리 작업이 지운다.
- 로그에 음원 내용·자막 본문·토큰을 남기지 않는다. 작업 ID·상태·소요 시간·오류 코드만 남긴다.

공개 서버(broker) 규칙:

- 공인 IP에는 443 하나만 연다. OCI security list와 인스턴스 방화벽 양쪽에 같은 규칙을 둔다. 인증서는 TLS-ALPN-01(Caddy 또는 Go `autocert`)로 받아 80도 열지 않는다.
- SSH와 worker API는 tailnet 인터페이스에만 bind한다. Tailscale ACL은 `tag:caption-worker` → `tag:caption-broker`의 worker API 포트만 허용한다. 서버 노드는 태그로 등록해 키 만료로 연결이 끊기지 않게 한다.
- 업로드 본문은 메모리에 모으지 않고 spool 파일로 스트리밍한다. 선언된 총 크기와 실제 누적 바이트를 모두 검사하고(`http.MaxBytesReader`), 상한을 넘으면 즉시 중단하고 413을 준다.
- `ReadHeaderTimeout`과 진행 없는 업로드 idle timeout으로 느린 연결이 자원을 붙잡지 못하게 한다.
- rate limit: 사용자 토큰별 작업 생성 수·동시 업로드 수·일일 총 음원 길이, IP별 인증 실패 횟수.
- ffprobe는 spool 로컬 파일만 입력으로 받는다(`-protocol_whitelist file`). URL을 입력으로 넘기지 않는다.
- R2 버킷은 비공개로 둔다(public bucket URL·`r2.dev` 비활성). API 토큰은 broker용 하나를 버킷 단위 권한으로 발급한다.
- R2 토큰, DB 비밀번호, 워커 토큰은 서버 설정·환경 변수에만 두고 저장소에 커밋하지 않는다. 각각 독립적으로 회수할 수 있어야 한다.
- OS 보안 업데이트는 자동 적용한다.

완료 조건:

- `curl`만으로 생성 → 업로드 → 대기 → 자막 조회 → 삭제가 된다.
- 손상 파일, 크기 초과, 잘못된 토큰, 중복 Idempotency-Key, 처리 중 워커 강제 종료 후 재시작, 완료와 취소의 경합을 다루는 테스트가 있다.
- 워커 재시작 뒤 `running`이던 작업이 lease 만료 후 다시 처리된다.
- README에 Mac에서의 실행·재부팅 후 자동 시작·워커 토큰 발급·Google OAuth client 설정 방법이 있다(`docs/OPERATIONS.md`).

### 3단계. 확장: 음원 취득·업로드·결과 표시 (이 저장소)

목적: 사용자가 보고 있는 KU 플레이어 영상의 음원을 서버로 보내고, 자막을 기존 자막 화면에 표시한다. 전부 `UNIDOCK_AI_CAPTIONS=1` 빌드에만 존재한다.

#### 3-1. 빌드 플래그와 패키징 가드

기존 `UNIDOCK_PLAYBACK` 패턴을 그대로 복제한다.

| 파일 | 변경 |
| --- | --- |
| `wxt.config.ts` | `const aiCaptions = process.env.UNIDOCK_AI_CAPTIONS === "1"`. 참일 때만: `permissions`에 `declarativeNetRequestWithHostAccess`와 `identity`, manifest `key`(확장 ID 고정. broker가 연결 코드를 돌려보내는 `https://<ID>.chromiumapp.org/` 허용 목록과 CORS 허용 목록이 이 ID에 묶인다), `optional_host_permissions`에 CDN 호스트, extension CSP `connect-src`에 CDN 호스트와 `process.env.UNIDOCK_CAPTION_SERVER`(필수, `https://` origin 하나). `define`에 `__UNIDOCK_AI_CAPTIONS__`와 `__UNIDOCK_CAPTION_SERVER__` 추가. 설명 문구는 바꾸지 않는다 |
| `src/build-flags.d.ts` | 두 상수 선언 추가 |
| `package.json` | `build:ai-captions`, `test:e2e:ai-captions` 스크립트 추가 |
| `scripts/package-release.mjs` | `UNIDOCK_AI_CAPTIONS=1`이면 실패. 번들에서 `declarativeNetRequest`, CDN 호스트, 아래 메시지 타입 마커가 발견되면 실패 |
| `tests/e2e/build-shape.ts` | `aiCaptionsBuild()` 추가 (manifest에 `declarativeNetRequestWithHostAccess`가 있는지로 판별) |
| `src/AGENTS.md`, `AGENTS.md` | 플래그·가드·금지 사항 한 줄씩 추가 |

`vitest.config.ts`의 `define`에 `__UNIDOCK_AI_CAPTIONS__: "true"`와 `__UNIDOCK_CAPTION_SERVER__`(테스트용 origin)를 추가한다(기존 `__UNIDOCK_PLAYBACK__` 옆). release 빌드에서 관련 코드가 tree-shake 되는지는 번들 마커 검사로 증명한다.

#### 3-2. 미디어 식별 (sidepanel → 현재 탭)

| 파일 | 변경 |
| --- | --- |
| `src/captions/media-source.ts` (신규) | `chrome.scripting.executeScript`로 현재 탭의 `uniPlayerConfig`에서 **데이터 descriptor만** 읽어 `{ mediaUrl, durationS, contentId }`를 돌려준다. 기존 `src/captions/extract.ts`의 `own`/`data` 접근 규칙을 그대로 쓴다(플레이어 메서드·getter 호출 금지). URL은 반드시 `https://korea-cms-object.cdn.gov-ntruss.com/contents7/kruniv1001/{13 hex}/contents/media_files/*.mp4` 패턴과 일치해야 하고, 아니면 `UNSUPPORTED_MEDIA`로 끝낸다. `isIntro: true` story는 제외한다 |
| `src/security/policy.ts` | `allowedCaptionMediaUrl(url)` 추가. 위 패턴, `https:`, query·hash·credential 없음, 길이 상한 |

#### 3-3. 취득과 오디오 분리 (sidepanel 안에서 실행)

1단계 구현은 **side panel이 열려 있는 동안** 진행한다. 패널이 닫히면 진행 중인 취득·업로드는 중단되고 사용자에게 그렇게 안내한다. offscreen document·background 상주 처리는 이번 범위가 아니다.

| 파일 | 변경 |
| --- | --- |
| `src/captions/referer-rule.ts` (신규) | `withCaptionMediaRule(mediaUrl, fn)`: `chrome.declarativeNetRequest.updateSessionRules`로 규칙 하나를 추가하고 `fn`이 끝나면(성공·실패·취소 모두) 제거한다. 규칙 조건: `urlFilter`는 해당 미디어 URL 정확히 하나, `initiatorDomains`는 확장 자신(`chrome.runtime.id`), `resourceTypes: ["xmlhttprequest"]`, 동작은 `requestHeaders`에 `Referer: https://kucom.korea.ac.kr/` `set` 하나. 규칙 ID는 고정 범위에서 쓰고, 시작 시 같은 ID의 잔존 규칙을 먼저 지운다 |
| `src/captions/audio-extract.ts` (신규) | `fetch(mediaUrl, { credentials: "omit", cache: "no-store", redirect: "error" })`를 스트리밍으로 읽어 오디오 트랙만 `.m4a`로 재다중화한다. 메모리에 영상 샘플을 쌓지 않는다. `moov`가 파일 끝에 있으면 Range로 `moov`를 먼저 읽고 `mdat`의 오디오 chunk만 Range로 가져온다. 라이브러리는 mp4box.js를 1순위로 하되, 전체 파일을 메모리에 올리는 방식은 금지. AAC 재다중화가 불가능한 입력(예: 오디오 트랙 없음)은 `UNSUPPORTED_MEDIA` |
| `scripts/notices.mjs` 결과 | 새 의존성은 `npm run notices`로 `THIRD_PARTY_NOTICES.txt`에 반영한다 |

메모리 상한: 분리 과정의 peak가 100 MB를 넘지 않아야 한다(463 MB 표본 기준). 넘으면 설계를 바꾸지 말고 보고한다.

#### 3-4. 서버 클라이언트와 상태

| 파일 | 변경 |
| --- | --- |
| `src/captions/job-client.ts` (신규) | 공개 API(`public.openapi.yaml`)를 감싼다. base URL은 `__UNIDOCK_CAPTION_SERVER__` 고정. 세션 토큰은 `chrome.storage.local`의 `unidock.caption-session.v1`에서 읽고, `TOKEN_EXPIRED`면 refresh 후 한 번 재시도한다. 진행 중 작업과 그 강의 키는 `unidock.caption-active-job.v1`에 둔다(서버는 강의를 모른다). 응답은 `unknown`으로 받아 닫힌 스키마로 검증하고 크기 상한을 둔다. 오류는 고정 코드로만 노출한다 |
| `src/captions/job-state.ts` (신규) | `idle → identifying → extracting → uploading → queued → running → succeeded | failed | cancelled`. 진행률은 관측 가능한 값만(분리된 바이트, 업로드 바이트, 서버 `progress`) |
| `src/captions/transcript.ts` | 서버 JSON(`segments[{start_ms,end_ms,text}]`) → 기존 `Transcript` 투영 함수 추가. 기존 추출 경로의 동작은 바꾸지 않는다 |
| `src/captions/download.ts` | 기존 TXT 내보내기가 AI 자막에도 동작하도록. 파일명에 `AI` 표시. SRT/VTT는 이번 범위 밖 |
| `src/popup-settings.ts` 옆 `src/caption-server-settings.ts` (신규) | 로그인(`chrome.identity.launchWebAuthFlow`로 broker 시작 주소를 열고 연결 코드 + handoff verifier 교환)과 세션 저장·삭제. `LocalDataSettings.tsx`의 "로컬 데이터 삭제"가 세션 키와 매핑 키를 모두 지우게 한다 |

#### 3-5. UI

| 파일 | 변경 |
| --- | --- |
| `entrypoints/sidepanel/CaptionsPanel.tsx` | `NO_CAPTIONS`일 때만 `AI 자막 생성` 버튼을 보인다. `UNSAFE_CAPTION`·기타 오류에서는 보이지 않는다. 누르기 전에 "현재 강의의 음성을 `<서버 origin>`으로 보냅니다. 음성은 생성 후 삭제되고 자막은 최대 6개월 보관됩니다"를 보여주고 확인을 받는다. 같은 음원의 기존 자막에 연결되면 남은 기간이 더 짧을 수 있으므로, 실제 만료일은 완료 후 자막의 `expires_at`으로 표시한다. 결과에는 `AI 생성` 표시와 엔진·모델명을 붙이고, 원본 자막과 시각적으로 구분한다 |
| `entrypoints/sidepanel/useAiCaptions.ts` (신규) | 3-2~3-4를 묶는 훅. 패널 메뉴 전환이나 다른 브라우저 탭 선택으로는 작업을 유지한다. 작업을 시작한 강의 탭의 문서가 이동·새로고침되거나 탭이 닫히면 진행 중 작업을 취소하고 결과를 폐기한다(기존 `CaptionsPanel`의 자막 초기화와 같은 규칙). 패널을 닫으면 로컬 취득만 멈추고 서버가 접수한 작업은 남는다 |
| `entrypoints/sidepanel/CaptionServerSettings.tsx` (신규) | Google 로그인·로그아웃, 이번 주 남은 횟수, 서버 origin 표시(수정 불가), worker 상태(`/v1/service-status`). 정보 화면에 `PopupSettings` 옆에 둔다 |

모든 UI 코드는 `__UNIDOCK_AI_CAPTIONS__` 가드 안에 있어야 한다. release 빌드에서는 버튼도 설정도 존재하지 않는다(playback처럼 비활성 항목을 남기지 않는다).

#### 3-6. 문서

| 파일 | 변경 |
| --- | --- |
| `documentation/SECURITY-REVIEW.md` | 새 권한·호스트·CSP·DNR 규칙·데이터 흐름·잔여 위험 |
| `README.md` | 개발 빌드 전용 기능임을 명시, 빌드 방법 |
| `public/privacy.html` + `npm run pages:sync` | release 빌드에는 기능이 없으므로 **지금은 수정하지 않는다.** 스토어 제출 단계에서 다룬다 |

#### 3단계 완료 조건

기능:

- `UNIDOCK_AI_CAPTIONS=1 UNIDOCK_CAPTION_SERVER=https://… npm run build:ai-captions` 결과를 로드하고, 자막 없는 KU 영상에서 `AI 자막 생성` → 확인 → 분리 → 업로드 → 대기 → 자막 표시 → TXT 내보내기가 된다.
- 같은 영상을 두 번 요청하면 서버가 Idempotency-Key로 중복을 막고 패널은 기존 작업 상태를 보여준다.
- 패널을 닫았다가 같은 강의에서 다시 열면 서버에 접수된 작업의 상태를 다시 조회해 보여주고, 접수 전이던 작업은 사라진다.
- 로그인하지 않으면 `AI 자막 생성` 대신 Google 로그인 안내가 보인다. 로그인 → 사용 → access 만료 후 자동 refresh → 로그아웃이 된다. `REFRESH_REUSED`나 refresh 실패면 세션을 지우고 로그인 안내로 돌아간다.
- `QUOTA_EXCEEDED`면 버튼을 비활성화하고 초기화 시각(`quota.resets_at`)을 보여준다. `ACTIVE_JOB_EXISTS`면 진행 중인 작업 화면으로 간다. `/v1/service-status`가 `offline`이면 생성은 허용하되 "처리 서버가 꺼져 있어 대기합니다"를 표시한다.
- "로컬 데이터 모두 삭제"가 세션과 강의 ↔ 작업 매핑을 지우고 서버 세션도 폐기(`POST /v1/auth/logout`)한다.

보안·경계:

- `npm run build`(플래그 없음)의 manifest에 `declarativeNetRequestWithHostAccess`, CDN 호스트, 서버 origin이 없고, 번들에 마커가 없다. `scripts/package-release.mjs`가 플래그 빌드를 거부한다.
- 세션 규칙은 취득 시작 시 추가되고 성공·실패·취소·패널 종료 모두에서 제거된다. 규칙이 남은 상태로 끝나는 경로가 없다.
- 영상 바이트는 메모리 밖(`storage`, `downloads`, 서버)으로 나가지 않는다. `chrome.downloads`는 자막 TXT에만 호출된다.
- 미디어 URL은 현재 탭의 `uniPlayerConfig`에서만 오고, 패턴 검사를 통과하지 않으면 요청하지 않는다. 임의 URL을 받는 코드 경로가 없다.
- 서버 요청 본문·로그·analytics에 LMS URL, 과목 ID, 강의 제목, 토큰이 들어가지 않는다. 기존 `redactText` 경계를 지킨다.
- Google 토큰과 Google 인가 코드는 확장에 오지 않는다(broker가 Google 콜백을 받는다). 확장은 broker가 `https://<고정 ID>.chromiumapp.org/`로 돌려준 1회용 연결 코드를 state와 `iss`(= broker origin)가 맞을 때만 handoff verifier와 함께 한 번 보내고 버린다. `chrome.storage.local`에는 broker 세션만 저장한다.
- `npm run build`(플래그 없음)의 manifest에 `identity`와 `key`가 없다.

테스트:

- Vitest: `media-source`(descriptor-only 읽기, 패턴 거부), `referer-rule`(추가·제거·예외 시 제거·잔존 규칙 정리), `audio-extract`(작은 합성 MP4 fixture로 오디오만 남는지, 영상 샘플이 버퍼에 없는지, 메모리 상한), `job-client`(스키마 거부, 크기 상한, 오류 코드), `job-state` 전이, `transcript` 투영, `CaptionsPanel`의 버튼 노출 조건과 확인 다이얼로그. 로그인: PKCE verifier·S256 challenge, state·nonce 생성과 검증, redirect URL 파싱(다른 호스트·state 불일치·`error` 파라미터 거부), refresh 단일 비행(동시 401 여러 개에도 refresh 1회), `REFRESH_REUSED` 처리, quota 표시. 커버리지 80% 유지.
- Playwright: `tests/e2e/ai-captions-lifecycle.spec.ts`. 합성 LMS에 KU 플레이어 흉내 페이지와 가짜 CDN(Referer 없으면 403, 있으면 206 + 작은 MP4)과 가짜 서버를 추가한다. 검증: 규칙 추가·제거, 403→206 전환이 규칙 때문인지, 업로드 본문이 오디오만인지, 패널 종료 시 정리. `aiCaptionsBuild()`가 거짓이면 skip. 로그인 흐름은 e2e로 돌리지 않는다. 실제 Google 화면도, broker 시작 주소·연결 코드 교환도 자동화하지 않고, 로그인된 경우는 저장소에 세션을 미리 넣어 시작한다. e2e가 확인하는 것은 다섯 가지다: 세션 규칙만으로 CDN 403이 206이 되고 오디오만 올라감, 워커가 20번 넘게 재시작해도 규칙이 유지되고 작업이 끝남, 패널을 닫으면 background가 규칙을 지움, 세션이 없으면 로그인 안내만 보이고 아무 요청도 보내지 않음, `QUOTA_EXCEEDED`면 미디어를 읽기 전에 안내함. 로그인(시작 주소, state·`iss` 확인, 연결 코드 교환), refresh, 로그아웃, 모든 기기 로그아웃과 그 경합은 단위 테스트(`tests/caption-server-settings.test.ts`, `tests/caption-api-contract.test.ts`)로만 확인한다. CI는 이 e2e를 돌리지 않는다.
- `npm run check` 통과. release 빌드 E2E(`npm run test:e2e`)가 그대로 통과.

수동 게이트(에이전트가 완료를 주장하지 않는다):

- 실제 LMS·실제 CDN·실제 서버로 한 강의 전체를 처리해 자막이 나온다.
- Chrome 114에서 플래그 빌드가 로드된다(DNR 세션 규칙은 Chrome 84+, `declarativeNetRequestWithHostAccess`는 96+).
- Google Cloud에 Web application OAuth client를 만들어 redirect URI로 broker 콜백(`https://<broker>/v1/auth/google/callback`) 하나만 등록하고, broker 허용 목록에 고정 확장 ID를 넣은 뒤, 실제 Google 계정으로 로그인 → 생성 → 로그아웃 → 모든 기기 로그아웃이 된다.

### 4단계. 스토어 제출 준비 (이번 범위 밖)

리서치 문서 4.2.2의 조치를 갖춘 뒤 별도 브리프로 다룬다. Google 로그인으로 이메일을 수집하므로 `public/privacy.html`과 스토어 Privacy practices에 계정 정보 수집과 보관·삭제(계정 삭제 API)를 추가하는 것도 그 범위다. 3단계에서 미리 해 둘 것은 "숨기지 않기"뿐이다: 규칙·권한·흐름이 코드에서 그대로 읽히게 쓴다.

## 2. 비범위 (하지 말 것)

- **재생 속도 조작, 자동 재생, 재생 대기 중 keepalive.** `tabCapture` 경로도 이번에는 만들지 않는다.
- **일괄 처리.** 강의 목록에서 여러 영상을 고르거나 과목 전체를 큐에 넣는 UI·API를 만들지 않는다. 시작점은 항상 현재 보고 있는 플레이어 하나다.
- **임의 URL.** 사용자 입력, 게시판 HTML, 서버 응답에서 온 URL로 미디어를 요청하지 않는다. `uniPlayerConfig` descriptor에서 읽어 패턴 검사를 통과한 것만 쓴다.
- **영상 또는 음원 파일 제공.** MP4·m4a·Opus를 사용자에게 저장하게 하는 버튼·단축키·숨은 경로를 두지 않는다. 결과물은 자막뿐이다.
- **Referer 외 헤더 수정, 정적 DNR 규칙, 탭 요청에 적용되는 규칙.** 규칙은 확장 자신의 요청 하나에만 붙는다.
- **CDN 외 호스트 권한 확대, `connect-src` 와일드카드, `cookies`·broad `tabs`·all-sites 권한.**
- **서버에 LMS 쿠키·토큰·signed URL·과목 ID·강의 제목 전송.** 서버는 음원, 작업 메타데이터(형식·크기·길이·언어), 그리고 quota와 소유 확인에 필요한 Google 계정 식별자(`sub`, 이메일)만 받는다. 작업은 사용자에게 연결되지만, 어느 과목·강의인지는 서버가 알 수 없다.
- **알림(Telegram·Discord), SRT/VTT 내보내기, 번역·요약.** 모두 후속 단계다. (공유 캐시와 Google OAuth 다중 사용자는 2026-10-24 결정으로 범위에 들어왔다.)
- **기존 자막 감지 경로 변경.** `detectCaptions`, `extract.ts`, `normalize.ts`의 동작과 contract fixture는 건드리지 않는다. `UNSAFE_CAPTION`을 AI 생성으로 자동 전환하지 않는다.
- **release 빌드에 흔적 남기기.** 비활성 버튼, 안내 문구, 설정 항목 어느 것도 release 빌드에 넣지 않는다.
- **`public/privacy.html`·스토어 자산 수정.** 4단계에서 다룬다.
- **Referer 값·규칙·흐름을 난독화하거나 원격 설정으로 숨기기.** 4.2.2 전제 위반이다.

## 3. 보고 형식

각 단계가 끝나면 다음을 PR 설명 또는 결과 보고에 넣는다.

1. 완료 조건 각 항목에 대한 통과/실패/미검증 표시. 미검증은 이유와 함께 남긴다. 합성 테스트 통과를 실제 LMS 검증으로 쓰지 않는다.
2. 바뀐 권한·호스트·CSP·storage 키의 전후 비교.
3. 이 브리프나 리서치 문서와 다르게 한 결정과 그 이유.
4. 측정값(3단계: 분리 peak 메모리, 분리·업로드 시간; 1단계: RTF·CER 표).

막히면 우회하지 말고 멈춘다. 특히 CDN 응답이 이 문서의 확정 사실과 다르면(403이 Referer로 풀리지 않음, 형식이 MP4가 아님, 서명 query가 생김) 구현을 바꾸지 말고 보고한다.
