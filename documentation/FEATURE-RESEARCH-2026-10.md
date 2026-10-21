# uniDock 다음 단계 설계 리서치

- 조사일: 2026-10-20 (AI 자막 모델·음원 경로 보강: 2026-10-21)
- 대상: 자막 없는 영상의 AI 자막 생성, Telegram·Discord 알림, LMS 공지 레이어 자동 닫기
- 브랜치: `research/captions-notifications-popups`
- 코드 기준: 로컬 `main`, `bf5abd26e030d2886f64a753a0d6cc34869d6a6f`

## 1. 결론

**팝업 자동 닫기를 먼저 출시하고, AI 자막은 음원 확보 가능성부터 검증하며, 알림은 서버의 작업·인증 기반이 생긴 뒤 붙이는 순서를 권한다.** 세 기능을 한 번에 구현할 이유는 없다.

사용자가 제안한 **Mac mini 추론 워커 + 별도 Go 서버 + 학기 단위 자막 캐시**는 합리적인 출발점이다. 다만 어려운 부분은 모델 실행보다 다음 세 가지다.

1. 로그인된 LMS에서 음원을 어떤 허용된 경로로 얻는가.
2. 서버에 남은 자막을 누가 열람할 수 있는가.
3. Mac이 꺼지거나 재시작되어도 작업과 삭제 기한을 지킬 수 있는가.

이 보고서의 권고는 아래처럼 요약된다. P0·P1·P2는 작업 순서이며, 실제 개발 소요 시간은 미디어 접근 조사 뒤 산정한다.

| 순서 | 기능 | 첫 배포 범위 | 다음 단계로 넘어갈 조건 |
| --- | --- | --- | --- |
| P0 | 공지 레이어 자동 닫기 | 확인된 LMS 공지 레이어의 닫기 버튼만 자동 클릭 | 실제 DOM·클릭 부작용 확인, 다른 대화상자를 건드리지 않는 회귀 검증 |
| P1a | AI 자막 기술 검증 | 사용자가 제공할 수 있는 음원으로 Mac에서 생성 | 한국어 품질·타임스탬프·시간·메모리 실측 |
| P1b | 개인용 자막 서비스 | Go 작업 API, 개인 전용 캐시, 삭제, 실패 복구 | 로그인·업로드·워커 재시작·만료 삭제 검증 |
| P1c | LMS 연결 | 접근이 확인된 미디어 유형만 지원 | 음원 취득 성공, 쿠키 전송 없이 동작, 출석 처리와 분리 |
| P2 | 알림 | Telegram 개인 알림, 이후 Discord 채널 | 수집 가능한 이벤트·수집 중단 상태·중복 처리 규약 확정 |

**공유 캐시, 전 강의 자동 수집, 24시간 신규 공지 감지는 첫 버전에 넣지 않는 편이 좋다.** 편의 기능 하나가 학교 인증을 대행하는 서비스로 커지기 쉽다.

## 2. 조사 기준과 확인 범위

### 코드에서 직접 확인한 사실

| 근거 | 현재 동작 | 설계에 미치는 영향 |
| --- | --- | --- |
| `src/captions/service.ts:43`, `:322` | 기존 자막을 감지하며 없으면 `NO_CAPTIONS` 또는 `UNSAFE_CAPTION` | ASR은 기존 추출기의 숨은 fallback이 아니라 별도 사용자 동작으로 추가 |
| `src/captions/extract.ts:4`, `:48`, `:85` | DOM, 플레이어 자막 파일, 이미 로드된 스크립트를 읽음 | 현재 구현을 음원 다운로드 기능으로 간주하면 안 됨 |
| `src/captions/transcript.ts:1` | cue 시작 시각 중심이며 밀리초·끝 시각을 보존하지 않음 | ASR 원본은 별도 정밀 스키마로 저장하고 기존 화면에 투영 |
| `entrypoints/sidepanel/CaptionsPanel.tsx:38`, `:97`, `:111` | 탭·문서 변경 시 결과 폐기, 성공 결과는 5분 뒤 해제 | 서버 작업 수명과 현재 탭 표시 수명을 분리 |
| `entrypoints/lms.content.ts:290` | LMS 최상위 프레임, `document_idle` 실행 | 팝업 전용 진입점을 분리하면 기존 조회 동작을 건드리지 않음 |
| `src/security/policy.ts:19` | 정해진 Canvas GET 경로만 허용 | 공지 API를 쓰려면 명시적 경로·query 정책 및 테스트 추가 |
| `wxt.config.ts:20`, `:28`, `:43` | 제한된 권한·학교 호스트, extension CSP의 외부 연결은 PostHog | 새 API 호스트의 권한·CSP·릴리스 검사 함께 변경 |
| `AGENTS.md`, `src/AGENTS.md` | LMS 원본·자격증명·서명 URL 보관 금지, 제한된 로컬 저장 | 생성 자막 보관·연동 상태·알림 baseline은 신규 데이터 계약 필요 |

코드 검색 범위에서는 LMS 공지 레이어를 자동으로 닫는 기존 구현을 찾지 못했다. `background.ts`의 popup은 확장 사이드패널 대체 UI로, 이번 대상과 다르다.

사용자는 자동 닫기 대상을 **페이지 안 공지 레이어**로 확인했다. 별도 브라우저 창 차단은 범위에서 제외한다.

### 후속 대화에서 사용자 제공·확인된 사실

- 제공된 HTML에서 `#xn-popup-wrapper` 아래에 `.xnp-item-wrapper[data-popup-id]` 공지 항목들이 있다.
- 공지 본문은 `.xnp-item-content`의 Shadow DOM 안에 있지만, `.xnp-item-close`와 닫기 버튼은 그 밖의 일반 DOM에 있다. 닫기에는 Shadow DOM 탐색이 필요 없다.
- 사용자가 아래 3.1절의 콘솔 명령으로 공지가 닫히는 것을 확인했다.
- 사용자가 공지를 닫은 뒤에도 `#xn-popup-wrapper` 자체는 남아 있다고 확인했다. 따라서 wrapper 내부에 새 요소가 추가되는 흐름을 감시하는 것으로 설계한다.
- 구현 착수 후 사용자가 주소창 도메인을 `lms.korea.ac.kr`로 확인했다. 조회용 두 LMS origin과 구분해 팝업 전용 호스트로 취급한다.

이 내용은 사용자 제공 HTML과 실행 결과를 근거로 하며, 에이전트의 실제 브라우저 검증과 구분한다.

### 이번에 검증하지 못한 것

- BrowserSkill daemon은 있으나 연결된 브라우저 확장이 없어 실제 LMS 이벤트·네트워크를 직접 검사하지 못했다. **선택자와 열린 팝업의 클릭 성공은 사용자 확인을 받았지만, 생성 직후의 핸들러 준비 시점과 클릭 부작용은 미검증**이다.
- 실제 Mac mini의 칩·메모리, 대상 강의 음원, ASR 실행 시간·정확도는 측정하지 않았다. 작업 머신 정보를 추론 서버 사양으로 대신하지 않았다.
- 학교의 Canvas API 노출 범위, OAuth 허용, Live Events 사용 권한은 확인하지 않았다. 공식 Canvas 문서의 기능 존재가 학교에서의 사용 가능성을 뜻하지 않는다.
- 브랜치는 요청대로 로컬 main에서 생성했다. 조회 당시 로컬 main은 기존 remote-tracking `origin/main`보다 19커밋 뒤였다. 원격 fetch·병합은 하지 않았으므로 이 보고서는 최신 원격 코드에 대한 분석이라고 주장하지 않는다. 구현 착수 전 원격 변경과 설계 연결 지점을 다시 비교해야 한다.

이하 **현재 동작**은 코드 근거, **기술 기능**은 말미의 공식 자료, **권고**는 이번 설계 판단이다.

## 3. 공지 레이어 자동 닫기: 가장 먼저 만들 기능

### 3.1 권고 구현

전용 content script `entrypoints/lms-popup.content.ts`와 식별·닫기 로직 `src/lms-popup.ts`로 구현했다. 설정은 `src/popup-settings.ts`, 정보 화면의 `entrypoints/sidepanel/PopupSettings.tsx`에 둔다. 기본 비활성이며 `unidock.popup-auto-close.v1` boolean만 저장한다.

사용자가 열린 팝업에서 동작을 확인한 콘솔 명령:

```js
document.querySelectorAll(
  "#xn-popup-wrapper > .xnp-item-wrapper[data-popup-id]" +
  " > .xnp-item-close > button.xnp-item-close-button"
).forEach((button) => button.click());
```

특정 `data-popup-id` 값은 고정하지 않는다. 이 명령은 이미 존재하는 공지를 닫는 최소 예시이며, 아래 감시·설정·정리 루틴까지 구현한 코드는 아니다.

**권고 루틴은 `document_idle`에서 시작하는 최초 1회 탐색 + 유지되는 wrapper 내부의 추가 노드 감시다.** background에서 매번 스크립트를 주입하거나 주기적인 타이머로 페이지를 검색하지 않는다.

```text
LMS 최상위 문서의 document_idle
  -> 자동 닫기 설정 확인
     -> OFF: 감시하지 않고 종료
     -> ON: #xn-popup-wrapper 탐색
        -> 없으면 임시 문서 감시로 wrapper 생성을 기다림
        -> 발견하면 임시 감시 해제
        -> wrapper 내부 감시 등록
        -> 이미 있는 공지 항목을 1회 처리
        -> 이후 추가된 노드가 속한 공지 항목만 처리
           -> 닫기 버튼 검증 및 클릭
           -> 같은 버튼은 감시 세션에서 다시 클릭하지 않음

설정 OFF / pagehide / content script 해제
  -> observer 해제 및 대기 작업 정리
설정 ON / bfcache pageshow 복원
  -> 중복 observer 없이 설정 재확인 후 감시 재개
```

Content script는 페이지와 DOM을 공유하면서 실행 환경은 분리할 수 있다. `document_idle`은 DOM 구성 이후 실행 시점이지만, 비동기 팝업의 초기화 완료까지 보장하지는 않는다.[R1] 버튼 생성 직후에도 클릭이 정상 처리되는지는 구현 때 확인한다.

권고 세부 동작:

- **공지 포털 `https://lms.korea.ac.kr/*`의 최상위 문서에서만** 동작한다. 기존 Canvas API용 `LMS_MATCHES`는 넓히지 않는다. 포털 호스트 권한과 해당 content script만 배포 allowlist에 추가한다.
- `MutationObserver`를 wrapper에 `{ childList: true, subtree: true }`로 등록한다. 공지 항목이 먼저 생기고 닫기 버튼이 나중에 붙는 경우도 감지한다.[R2] wrapper가 유지된다는 확인에 따라 상시 문서 전체 감시나 wrapper 교체 복구는 넣지 않는다.
- wrapper가 처음에는 없다면 임시 문서 observer를 등록한 뒤 존재 여부를 다시 확인한다. 발견 후 wrapper observer를 먼저 등록하고 기존 항목을 처리해 초기 탐색과 구독 사이의 누락을 막는다. wrapper가 아직 없는 동안 설정을 꺼도 임시 observer를 해제한다.
- callback마다 문서 전체를 검색하지 않는다. `addedNodes` 자체와 그 하위에서 후보를 찾고, 버튼 등 자식만 추가된 경우에는 해당 `.xnp-item-wrapper` 조상으로 연결한다. 후보가 현재 wrapper의 직계 공지 항목인지 확인한 뒤 `Set`으로 중복 제거하고 callback당 각 항목을 한 번만 처리한다.
- 위의 구체적인 컨테이너·닫기 버튼 구조를 사용한다. `.modal`, `.close`, `닫기` 문자열만으로 모든 대화상자를 누르지 않는다. 이미 분리된 항목이나 비활성 버튼은 클릭하지 않는다.
- 삭제만 발생한 mutation은 새 클릭 후보로 삼지 않는다. 스타일·텍스트 변화나 공지 본문 Shadow DOM을 상시 감시하지 않는다.
- 구현은 `WeakSet`에 클릭 시도한 버튼만 기록하며 성공 상태나 닫힌 개수를 표시하지 않는다. 버튼이 그대로 남아 있어도 반복 클릭하지 않는다. 실제 닫힘은 E2E에서 사이트의 클릭 핸들러가 공지를 제거하는 것으로 검증하고, 실제 LMS의 생성 직후 준비 시점은 별도로 확인한다.
- 향후 사용자에게 닫기 성공 상태를 제공한다면 클릭 전 완료 관찰을 등록하고 숨김·제거를 확인해야 한다. 현재는 성공 표시나 재시도가 없어 별도의 완료 observer·timeout을 추가하지 않는다.
- DOM을 강제로 지우거나 CSS로 숨기는 대신 사이트의 정상 닫기 버튼을 사용한다. 단, 그 클릭이 공지 읽음 기록이나 다른 mutation을 보내는지는 먼저 확인한다.
- `window.alert`, `confirm`, `window.open`을 덮어쓰거나 MAIN world에서 페이지 함수를 실행할 필요는 없다.

**열린 팝업의 닫기는 확인됐으므로, 다음 검증은 생성 직후 클릭과 반복 접속에서의 생명주기다.** 알려진 공지 구조 밖의 출석 확인·퀴즈 제출·개인정보 동의창은 대상으로 넓히지 않는다.

### 3.2 설정과 복구 UX

설정 카드 하나로 충분하다.

```text
LMS 공지 자동 닫기                  [켜짐 / 꺼짐]
LMS 접속 시 확인된 공지창만 닫습니다.
공지 내용은 LMS의 원래 공지 경로에서 확인하세요.
```

권고 기본값은 꺼짐이며, 사용자가 한 번 켜면 다음 접속부터 적용한다. 이번 사용자처럼 자동 닫기를 원한 경우 설정에서 켜는 경로를 바로 제공한다. `오늘 하루 보지 않기` 체크는 자동으로 선택하지 않는다. 이는 단순 닫기와 다른 지속 상태 변경이다.

다시 보기 링크는 실제 공지 목록 경로가 확인된 경우에만 제공한다. 존재하지 않는 범용 공지함 URL을 추측하지 않는다. 필요한 로컬 데이터는 설정 boolean과 스키마 버전 정도이며, 공지 본문을 저장할 이유는 없다. 이것도 현재 저장 allowlist에는 새 항목이므로 정책에 반영한다.

### 3.3 남은 증거와 구현 완료 조건

1. 제공된 구조를 바탕으로 공지 본문·base64 이미지·실제 ID를 제외한 최소 DOM fixture를 만든다. 버튼이 Shadow DOM 밖에 있다는 구조는 보존한다.
2. 사용자가 확인한 클릭 성공에 더해, 실제 클릭 전후 네트워크 메서드와 포커스·스크롤 잠금 해제를 확인한다.
3. 문서 시작부터 팝업이 나타나기까지의 초기화 흐름과, 요소 생성 직후 클릭이 처리되는 시점을 확인한다.
4. 최초 로딩·wrapper 지연 생성·항목/버튼의 단계적 추가·한 번에 여러 공지·같은 wrapper의 후속 공지·페이지 복귀·설정 OFF/ON을 검증한다. 삭제 mutation으로 재클릭하거나 observer가 중복 등록되지 않아야 한다.
5. 일반 dialog, 출석 확인, 퀴즈 제출, 로그인 창을 건드리지 않는 회귀 테스트.

테스트에서는 observer 또는 닫힘 이벤트를 클릭 전에 구독하고 bounded timeout으로 완료를 기다린다. 고정 sleep으로 통과시키지 않는다. 합성 LMS E2E 외에 설치된 production 확장으로 실제 LMS를 확인하고, 변경 전후 스크린샷과 콘솔·service worker 오류를 남겨야 한다.

## 4. 자막 없는 영상: 추출과 생성을 분리

### 4.1 사용자에게 보이는 기능

기존 `자막 감지`는 유지하고, 자막이 없을 때 **AI 자막 생성**을 별도 버튼으로 제시한다. `UNSAFE_CAPTION`이나 접근 실패를 서버 우회 요청으로 자동 전환하지 않는다.

```text
기존 자막 감지 -> 있으면 즉시 표시
             -> 없으면 AI 자막 생성 제안
                  -> 전송 대상·보관 만료일 안내
                  -> 사용자의 생성 요청
                  -> 음원 준비 / 업로드 / 대기 / 생성 중 / 완료
                  -> AI 생성 표시 + TXT·JSON, 향후 VTT·SRT
```

서버 대기열을 임의의 퍼센트로 보여주지 않는다. 진행량을 모르면 `대기 중`, chunk 수를 알면 `12 / 30 구간 처리`처럼 관측 가능한 값만 표시한다. 탭을 닫아도 접수된 작업은 서버에서 이어지되, 다른 강의 화면에 완료 결과를 잘못 붙이지 않는다.

### 4.2 가장 먼저 검증할 것: 음원 확보

자막 URL을 읽을 수 있다는 사실은 영상·음원 다운로드가 가능하다는 증거가 아니다. 현재 추출 코드는 제한된 자막 리소스와 로드된 텍스트를 다루며, 미디어 접근권한 전달 기능은 없다.

| 방법 | 장점 | 제약 | 권고 |
| --- | --- | --- | --- |
| 사용자가 확보한 파일을 명시적으로 업로드 | 모델·작업·캐시를 LMS와 독립적으로 검증 | 자동화 UX는 아님 | 첫 PoC |
| 허용된 미디어 경로에서 로그인 브라우저가 읽어 업로드 | 서버에 LMS 쿠키를 주지 않음 | 실제 CORS·미디어 권한·큰 파일 처리 검증 필요 | 지원 가능한 형식만 단계적으로 |
| 서버가 signed URL로 직접 수집 | 브라우저 부담 감소 | URL 자체가 bearer credential일 수 있음, 만료·로그 유출·SSRF | 첫 버전 제외 |
| 사용자가 시작한 탭 오디오 캡처 | 재생 가능한 소리를 처리하는 별도 경로 | 재생 시간만큼 캡처, 다른 소리 혼입, 새 권한·수명 관리 | 후순위 |

Chrome `tabCapture`는 사용자 호출을 전제로 하는 API다. Service worker에서 얻은 stream ID를 offscreen document가 소비하는 경로는 Chrome 116부터 문서화되어 있으므로, 현재 Chrome 114 최소 버전에 그대로 적용할 수 없다.[R3] 이를 백그라운드 전체 강의 다운로드처럼 설명하면 안 된다.

직접 읽기 경로를 조사할 때는 MP4/HLS/DASH 등 실제 형식, 음성 트랙, 세션 의존성, URL 만료, Range, CORS, 리다이렉트, DRM 여부를 작은 표로 기록한다. 접근이 막힌 형식은 `지원하지 않음`으로 남긴다. 미디어 다운로드가 출석 인정이라는 설명이나 출석 이벤트 호출도 넣지 않는다.

**의견:** 자동 음원 취득이 막히면 모델을 바꿔도 해결되지 않는다. 서버 구축을 크게 시작하기 전에 대표 강의 몇 개에서 이 경계를 먼저 조사하는 것이 비용을 줄인다.

#### 2026-10-21 실측: KU 플레이어 영상 1건

사용자의 로그인된 Chrome에서 읽기 전용으로 확인했다. 대상은 확률및랜덤과정 게시판에 올라온 `kucom.korea.ac.kr/em/{id}` 영상 하나다(게시판 2개에서 11건). 표본이 하나이므로 모든 강의의 일반 규칙으로 쓰지 않는다.

| 항목 | 관측 |
| --- | --- |
| 플레이어 페이지 | `kucom.korea.ac.kr/em/{id}`가 쿠키 없는 `curl`에도 200 HTML |
| 콘텐츠 형식 | `uniPlayerConfig._contentPlayingInfoData.contentType = "upf"`, 본편 story 1개, 약 3,938초 |
| 미디어 | `mainMediaList`의 `desktopMethod: "progressive"`, 단일 `media_files/screen.mp4` (HLS/DASH 아님, query 서명 없음) |
| 미디어 호스트 | 학교 도메인이 아닌 NCP CDN `korea-cms-object.cdn.gov-ntruss.com`. fallback으로 `kucom.korea.ac.kr/contents7_pseudo/...` 경로도 설정에 있음 |
| 쿠키·Referer 없는 직접 요청 | `curl -I` → **403** |
| 플레이어 페이지에서의 `fetch()` (`credentials: "omit"`, Range 0–1023) | **TypeError** (CORS 거부 또는 403; 구분 못 함) |
| 기존 자막 | 이 영상은 `useCaption: true`이고 caption XML이 있음 → 기존 `자막 감지`로 처리될 대상 |

해석:

- **서버가 URL만 받아 직접 받는 방식은 이 CDN에서 그대로 동작하지 않는다.** 403의 원인(Referer 검사, 쿠키, 기타)은 확정하지 않았다. Referer를 위조해 우회하는 방식은 학교 CDN의 접근 통제를 피하는 것이므로 검토 대상에서 제외한다.
- **페이지 world의 `fetch()`로 바이트를 읽는 방식도 막혔다.** `<video>` 재생은 되지만 CORS가 없는 교차 출처 미디어는 스크립트가 바이트를 읽을 수 없다. 같은 이유로 `video.captureStream()`도 tainted media가 되어 쓸 수 없을 가능성이 높다(미검증).
- 남은 후보는 (a) 확장 background가 CDN 호스트 권한으로 직접 GET하는 방식, (b) `kucom.korea.ac.kr/contents7_pseudo/...` fallback(이미 host permission 있음), (c) 사용자 시작 `tabCapture`다. (a)는 새 host permission이 필요하고 403이 Referer 검사 때문이라면 여전히 실패한다. Referer를 바꾸기 위해 `declarativeNetRequest`를 추가하는 것은 위와 같은 이유로 권하지 않는다. (b)는 이번에 응답을 확인하지 못했다. (c)는 재생 시간만큼 걸리고, 재생 속도를 자동으로 올리는 것은 이 프로젝트의 playback automation 금지와 충돌한다.
#### 2026-10-22 실측: 확장 service worker에서 Range 1KB 요청

같은 영상의 두 경로를 확장 background service worker에서 `fetch(url, { headers: { Range: "bytes=0-1023" }, credentials: "omit" })`로 요청했다. 실행 환경은 Playwright Chromium, 빈 임시 프로필(LMS 로그인 없음), `npm run build` 결과물이다. 두 변형을 썼다. 저장소 코드와 manifest는 바꾸지 않았고 scratch 사본만 수정했다.

- `shipped`: 현재 release manifest 그대로.
- `patched`: CDN host permission 추가, extension CSP `connect-src`에 `kucom.korea.ac.kr`과 CDN 호스트 추가.

| 경로 | `shipped` | `patched` |
| --- | --- | --- |
| (a) CDN `korea-cms-object.cdn.gov-ntruss.com/.../screen.mp4` | `TypeError: Failed to fetch` | **403** `text/html`, 본문 0 B, `content-range` 없음 |
| (b) pseudo `kucom.korea.ac.kr/contents7_pseudo/.../screen.mp4` | `TypeError: Failed to fetch` | **503** `text/html`, 326 B HTML 오류 페이지, 리다이렉트 없음 |

해석:

- **현재 release 빌드는 background에서 미디어를 읽을 수 없다.** 실패 원인은 CSP다. extension CSP의 `connect-src`가 PostHog만 허용해서, `kucom` host permission이 있어도 요청이 나가지 않는다. 기존 자막 추출이 동작하는 이유는 그 `fetch`가 extension CSP의 적용을 받지 않는 content script에서 실행되기 때문이다. background 취득을 하려면 manifest CSP 변경과 보안 검토가 먼저 필요하다.
- **권한을 열어도 두 경로 모두 바이트를 주지 않았다.** CDN은 쿠키·Referer 없는 확장 요청을 `curl`과 같은 403으로 거부했다. pseudo 경로는 MP4 대신 503 HTML을 반환했다. 레거시 Flash fallback 서버가 꺼져 있거나 이 영상을 제공하지 않는 것으로 보이며, 일시 장애인지는 반복 측정하지 않았다.
- 자막 XML이 있는 kucom 같은 출처 경로 `kucom.korea.ac.kr/contents7/.../media_files/screen.mp4`도 사용자가 `curl`로 확인했다. **200 `text/html`**로 HTML 페이지가 돌아왔고 MP4가 아니었다. 같은 출처 경로로 미디어를 읽는 방법도 없다.
- **403의 원인은 Referer hotlink 제한으로 확정됐다.** 사용자가 `Referer: https://kucom.korea.ac.kr/`만 붙인 `curl`(Range 0–1023)을 직접 실행해 **206 `video/mp4`, `content-range: bytes 0-1023/462754770`**을 받았다. 쿠키·서명·UA는 필요 없었다. 응답에 `access-control-allow-origin`이 없으므로 페이지·content script `fetch`가 실패한 이유는 CORS이고, 확장 background가 실패한 이유는 Referer 부재다. 파일은 약 463 MB(약 66분)이므로 브라우저에서 음원만 분리해 보내는 것이 필수다.
- 따라서 확장 background에서 `declarativeNetRequest` `modifyHeaders`로 해당 CDN 경로의 자기 요청에만 Referer를 붙이면 기술적으로 받을 수 있다. 이는 아래 4.2.1의 정책 판단 대상이다. 자동 모드 안전 검사가 이 추가 확인을 차단했다. 어느 쪽이든 Referer 위조는 검토 대상이 아니다.
- **결론: 현재 확인된 범위에서 "브라우저가 파일을 받아 서버로 업로드"하는 자동 경로는 열리지 않는다.** 남은 자동 경로는 사용자가 시작하는 `tabCapture`(Chrome 116+ offscreen, 실시간 길이)뿐이다. 그 외에는 사용자가 직접 확보한 파일을 업로드하는 첫 PoC 경로가 남는다. 다른 강의·다른 콘텐츠 유형(`upf` 외)은 별도 표본으로 다시 확인해야 한다.

#### 4.2.1 Referer 부착 경로의 정책 판단

기술은 확정됐으므로 남은 것은 세 층위의 정책이다. 서로 다른 질문이므로 섞지 않는다.

| 층위 | 질문 | 판단 |
| --- | --- | --- |
| 학교 규정 | 강의 녹화 음원이 LMS 밖(운영자 Mac)으로 나가도 되는가 | **Referer 경로와 탭 캡처 경로가 같은 문제를 가진다.** 자막 생성 자체를 하기로 했다면 이 층위에서 둘의 차이는 없다. 개인 학습 목적·재배포 없음·원본 음원 즉시 삭제를 전제로 하고, 학교 규정 확인은 별도 항목으로 남긴다 |
| 접근 통제 우회인가 | Referer 부착이 "권한 없는 접근"인가 | 같은 사용자의 같은 브라우저가 `<video>`로 이미 받는 바이트를, 같은 조건(Referer)으로 다시 요청하는 것이다. 쿠키·서명·로그인은 관여하지 않으며 hotlink 제한의 목적은 제3자 사이트 임베드 차단이다. 수강 권한이 없는 사람에게 접근을 열어 주지 않는다. **우회라기보다 브라우저 동작의 재현**으로 보는 것이 타당하지만, 이는 이 문서의 의견이지 학교의 해석이 아니다 |
| Chrome Web Store 심사 | 미디어 URL fetch + 헤더 수정이 "미디어 다운로더"로 보이는가 | **가장 실질적인 위험.** CWS는 스트리밍 미디어의 무단 다운로드를 돕는 확장을 금지하고, `declarativeNetRequest` 헤더 수정 + 학교 외 CDN 호스트 권한은 심사 설명이 필요하다. 거부 가능성은 있으나 확정이 아니며, 아래 완화 조치로 낮출 수 있다 |

**권고: Referer 경로를 채택하되, 먼저 개인용 빌드 플래그 뒤에 둔다.** 기존 `UNIDOCK_PLAYBACK=1`과 같은 방식으로 `UNIDOCK_AI_CAPTIONS=1` 빌드에서만 컴파일하고, release 패키징은 거부한다. 스토어 제출은 모델 PoC와 서버가 안정된 뒤 아래 완화 조치를 갖춘 상태로 별도 판단한다. 탭 캡처는 스토어 빌드용 대안으로 남겨 두되 먼저 구현하지 않는다.

스토어 제출 시 필요한 완화 조치:

- **범위를 최소로 고정한다.** DNR 규칙은 `korea-cms-object.cdn.gov-ntruss.com/contents7/kruniv1001/*/contents/media_files/*.mp4`에만, 확장 자신이 보낸 요청에만, Referer 값은 `https://kucom.korea.ac.kr/` 고정으로 적용한다. 탭의 일반 요청은 건드리지 않는다.
- **세션 규칙으로 작업 중에만 켠다.** 사용자가 생성을 요청하면 규칙을 추가하고 완료·실패·취소 시 제거한다. 영구 규칙을 두지 않는다.
- **현재 열린 플레이어에서 시작한다.** 미디어 URL은 사용자가 보고 있는 kucom 플레이어의 `uniPlayerConfig`에서 읽은 것만 쓰고, 임의 URL이나 다른 강의 ID를 받지 않는다.
- **CDN 권한은 `optional_host_permissions`로 둔다.** AI 자막을 처음 쓸 때 사용자가 승인하며, 설치 시점에는 요청하지 않는다.
- **영상은 저장도 제공도 하지 않는다.** 바이트는 스트리밍으로 읽어 음원 트랙만 분리하고, MP4나 음원 파일을 사용자에게 다운로드로 주지 않는다. 결과물은 자막뿐이다.
- `README.md`, `public/privacy.html`, `documentation/SECURITY-REVIEW.md`, 스토어 설명에 "사용자가 요청한 강의의 음원을 사용자가 지정한 자막 서버로 보낸다"는 사실과 보관·삭제 기한을 명시한다.

#### 업로드 형식: MP3일 필요는 없다

Whisper 계열은 입력을 16 kHz mono로 리샘플링해서 쓰므로, 서버로 보내는 형식은 **작고 브라우저가 기본으로 만들 수 있는 것**이면 된다. Chrome WebCodecs `AudioEncoder`가 안정적으로 제공하는 것은 Opus이고, MP3 인코더는 확인되지 않았다. MP3를 고집하면 lamejs·ffmpeg.wasm 같은 WASM 인코더를 번들해야 하고 확장 크기·CSP(`wasm-unsafe-eval`) 검토가 추가된다.[R17]

| 업로드 형식 | 1시간 크기(계산) | 브라우저 쪽 비용 |
| --- | --- | --- |
| 원본 MP4 그대로 | 영상 포함, 수백 MB 이상 | 없음, 대신 업로드·서버 디스크 부담 큼 |
| MP4에서 AAC 트랙만 demux | 원본 오디오 비트레이트에 비례 | 재인코딩 없음, MP4 box 파서 필요 |
| 16 kHz mono Opus 24 kbps (WebCodecs) | 약 10.8 MB | 디코딩 + `AudioEncoder`, 추가 라이브러리 불필요 |
| MP3 64 kbps | 약 28.8 MB | WASM 인코더 번들 필요 |
| 16 kHz mono 16-bit PCM WAV | 약 115 MB | 가장 단순, 가장 큼 |

**권고:** `tabCapture` 경로에서는 `MediaRecorder`/`AudioEncoder`로 Opus를 바로 만든다. 파일을 얻는 경로에서는 AAC 트랙 demux 또는 Opus 재인코딩을 비교한다. 서버는 형식을 MIME만으로 믿지 않고 FFmpeg로 길이·채널·코덱을 검증한다.

### 4.3 권고 배치 구조

```text
[Chrome 확장 / 인증된 업로드 페이지]
         | HTTPS: 명시적 생성 요청, 제한된 업로드
         v
[Go API 서버]
  인증 / quota / 입력 검증 / 상태 조회 / 결과 접근 검사
         |
         +-- [PostgreSQL: 작업, lease, 결과 메타데이터, 만료일]
         +-- [비공개 파일 저장소: 임시 음원, 자막 결과]
         ^
         | Mac에서 outbound 연결로 작업 수령·heartbeat·결과 제출
[Mac mini 워커]
  음원 디코딩 -> ASR -> 타임스탬프 검증 -> 결과 제출 -> 임시 파일 삭제
```

권고는 **Go 모놀리스 하나, DB 하나, Mac 워커 하나**다. 처음부터 Kubernetes·Kafka·Redis를 모두 도입하지 않는다. 별도 서버를 운영한다면 PostgreSQL에 작업 상태와 lease를 함께 두는 편이 단순하다. 완전히 개인용 단일 프로세스 실험이라면 SQLite도 가능하지만, 두 DB를 동시에 지원할 필요는 없다.

Go는 API·인증·작업 관리에 집중하고 모델을 Go에 직접 이식하지 않는다. Mac 워커는 Python 또는 CLI 프로세스로 모델을 실행해도 된다. 추론 실패가 API 프로세스를 죽이지 않도록 분리한다. Mac을 인터넷 inbound에 직접 노출하는 대신, Mac이 인증된 API로 작업을 가져오도록 한다.

서비스 인증은 LMS 로그인과 별개다. 개인용 PoC는 운영자가 발급한 회수 가능한 설치 자격증명으로 시작할 수 있고, 다중 사용자 서비스로 갈 때는 별도 로그인·기기 연결·탈퇴를 둔다. 정적 비밀을 확장 번들에 넣지 않는다. 이 인증이 성공해도 수강 권한이 증명되는 것은 아니다.

운영 시에는 워커 credential을 사용자 credential과 분리하고 작업 claim·결과 업로드 권한만 준다. Mac 재부팅 뒤 워커를 다시 시작하는 서비스 설정, 절전 방지 운영 정책, 디스크 상한, heartbeat와 대기열 지표를 준비한다. 시작은 동시 추론 1개로 하고 실측 후 늘린다. 서버가 정상이어도 Mac이 멈추면 `워커 오프라인`으로 표시해야 한다. “로컬 모델”은 운영자 Mac에서 처리한다는 뜻이지, 일반 사용자의 데이터가 그 사용자 기기를 떠나지 않는다는 뜻이 아니다.

### 4.4 엔진 선택

| 후보 | 공식 자료로 확인한 특성 | 이 프로젝트에서의 판단 |
| --- | --- | --- |
| `whisper.cpp` | Apple Silicon, Metal, Core ML 경로를 문서화한 C/C++ 구현 [R4] | CLI 워커와 배포 단순성을 중시하면 우선 비교 |
| `mlx-whisper` | MLX 기반 Python 구현, 모델 선택·단어 시각 출력 지원 [R5] | Mac 실험·모델 교체를 빠르게 진행할 첫 PoC 후보 |
| WhisperKit | Apple Silicon 대상 Swift 구현 [R6] | 향후 macOS 앱·네이티브 통합 필요가 있을 때 검토 |
| `faster-whisper` | CTranslate2 기반, GPU 실행 문서는 CUDA 중심 [R7] | NVIDIA 서버로 이동할 때 비교; Mac GPU 최적안으로 단정하지 않음 |

**권고:** 먼저 `mlx-whisper`와 `whisper.cpp`를 같은 음원·같은 계열 모델로 비교한다. 모델은 multilingual `large-v3`와 `turbo` 계열 등을 후보로 두되, 한국어 강의·영어 전문용어·잡음 구간에서 결과를 보고 결정한다. `tiny` 기본값을 그대로 제품 품질 기준으로 삼지 않는다. 엔진·모델 revision·양자화·디코딩 설정을 모두 고정해 기록한다.

테스트 데이터에는 한국어 단독 강의, 영문 용어 혼합, 음질 낮은 강의, 긴 무음, 실제 장시간 강의를 포함한다. 짧은 표본 정답 전사로 CER/WER를 보고, 사람 검수로 전문용어·숫자·의미 왜곡을 별도 평가한다. RTF는 `처리 시간 / 음원 길이`로 측정한다.

출시 판단에 필요한 측정값은 peak 메모리, cold/warm 실행 시간, 실패율, 무음 환각, cue 시간 오차, 동시 작업 시 대기 시간이다. 이 보고서는 어느 Mac에서 몇 배속이라고 보장하지 않는다.

#### Mac mini M4 16GB에서 돌아가는 후보 (2026-10-21 조사)

**메모리는 제약이 아니다.** 아래 후보는 모두 수 GB 안에서 동작하므로 16GB 통합 메모리에서 macOS와 함께 동시 1작업은 여유가 있다. 실제 제약은 처리 속도와 한국어 품질이며, 둘 다 M4 16GB에서 측정한 공개 자료를 찾지 못했다.

| 모델 | 크기·메모리 (공개 자료) | 한국어 | 타임스탬프 | 판단 |
| --- | --- | --- | --- | --- |
| Whisper `large-v3-turbo` | 809M, 모델 파일 약 1.6 GB [R18] | 지원 (multilingual) | segment 기본, word 실험 기능 | **1순위.** `mlx-whisper` 또는 `whisper.cpp`(Metal + Core ML encoder, Silero VAD) [R4][R5] |
| Whisper `large-v3` | `whisper.cpp` 기준 약 3.9 GB [R4] | 지원 | 위와 같음 | turbo의 품질 기준선. 느리지만 16GB에 충분히 들어감 |
| Qwen3-ASR-1.7B | MLX fp16 약 3.4 GB, 0.6B는 약 1.2 GB [R19][R20] | 30개 언어에 포함 | 별도 `Qwen3-ForcedAligner-0.6B`, **5분 단위 제한** | 2순위 비교. Apache-2.0. 타임스탬프 때문에 5분 chunk·offset 복원 필요 |
| 한국어 fine-tune (예: BuzzASR, large-v3 기반) | large-v3와 같은 계열 | 전용 | Whisper와 같음 | 자체 보고 CER 4.61% vs large-v3 5.72%(FLEURS+CV) [R21]. 라이선스·학습 데이터 조건 확인 후 후보 |

참고 처리 속도는 모두 **다른 하드웨어**다. M2 Ultra에서 turbo가 12분 음원을 14초에 처리했다는 보고, M4 Max에서 Qwen3-ASR-1.7B 8-bit 약 30배속 보고가 있다.[R18][R20] 기본 M4는 GPU 코어와 메모리 대역폭이 훨씬 작으므로 이 수치를 그대로 쓰지 않는다. 앞의 용량 계산에서 쓴 RTF 0.25 가정도 실측 전까지는 가정이다.

권고 PoC 순서:

1. `mlx-whisper` + `large-v3-turbo`로 대표 강의 3~5개(한국어, 영어 용어 혼합, 잡음, 긴 무음)를 돌려 RTF·peak 메모리·CER을 기록한다.
2. 같은 음원을 `whisper.cpp` turbo(Core ML encoder, `--vad`)로 돌려 속도와 무음 환각을 비교한다.
3. 품질이 부족하면 `large-v3`, Qwen3-ASR-1.7B, 한국어 fine-tune 순으로 비교한다. Qwen3-ASR은 aligner의 5분 제한 때문에 chunk 경계 검사를 포함한다.
4. 엔진·모델 revision·양자화·디코딩 설정을 결과 JSON의 `engine`·`model_revision`에 고정 기록한다.

### 4.5 작업 API와 장애 복구

다음은 제안 계약이며 구현된 API가 아니다.

| API | 목적 |
| --- | --- |
| `POST /v1/transcription-jobs` | 인증된 사용자 작업 생성, idempotency key 검사 |
| `POST /v1/transcription-jobs/{id}/audio` | 크기·길이·형식이 제한된 음원 업로드 |
| `GET /v1/transcription-jobs/{id}` | 소유자에게 상태·오류 코드·만료일 제공 |
| `POST /v1/transcription-jobs/{id}/cancel` | 취소 요청 |
| `GET /v1/transcripts/{id}` | 소유권과 만료를 확인한 결과 조회 |
| `DELETE /v1/transcripts/{id}` | 사용자 삭제 |

작업은 `awaiting_upload -> queued -> running -> succeeded / failed / cancelled`로 관리한다. 업로드가 완료·검증되기 전에는 큐에 넣지 않는다.

- 워커는 만료되는 lease와 attempt 번호를 받아 처리한다. heartbeat가 끊기면 회수 가능하게 하되, 이전 attempt의 늦은 결과는 저장하지 않는다.
- 재시도할 수 있는 네트워크 실패와 재시도해도 같은 형식 오류를 구분한다. 재시도 횟수·사용자별 총 음원 길이·일일 작업량에 상한을 둔다.
- 패널 연결이나 extension service worker를 작업 저장소로 삼지 않는다. MV3 worker는 종료될 수 있다.[R8]
- 결과 업로드는 임시 객체를 만든 뒤 검증과 DB 완료 처리를 거쳐 공개한다. 누락 객체와 고아 객체를 주기적으로 정리한다.
- 취소·사용자 삭제·학기 만료가 완료 처리와 경합하면 삭제가 우선하도록 tombstone 또는 상태 검사를 둔다. 늦은 워커가 삭제된 자막을 되살리지 못해야 한다.
- FFmpeg 등 디코더는 인자 배열로 호출하고 CPU·메모리·시간·디스크를 제한한다. 임의 URL을 받아 서버가 fetch하는 범용 프록시는 만들지 않는다.

### 4.6 자막 포맷

서버 원본은 `schema_version`, `language`, `engine`, `model_revision`, `pipeline_version`, `created_at`, `expires_at`, `segments[{start_ms,end_ms,text}]`를 갖는 JSON으로 권한다. cue 시간이 역전되거나 음원 길이를 벗어나면 거부한다.

긴 음원을 chunk로 나누거나 무음을 제거한다면 원래 영상 시간축으로 복원할 offset을 보존한다. 구간 경계의 중복 문장과 누락을 검사하고, 인식 결과를 번역하거나 요약해 원문 자막처럼 제공하지 않는다.

기존 `Transcript`는 표시·TXT 내보내기용 projection으로 유지한다. 기존의 초 단위 시작 시각만으로 SRT/VTT 종료 시각을 복원하지 않는다. AI의 시각은 추론 결과임을 표시하고, 원본 자막과 출처를 구별한다. 기존 `sourceUrl`·`pageTitle`을 서버 요청에 그대로 복사하지 않는다. 특히 쿼리 포함 LMS/LTI URL은 서버 저장 필드가 되어서는 안 된다.

### 4.7 학기 캐시: TTL보다 중요한 것은 권한

**학기 보관은 Redis 캐시 하나의 문제가 아니라, 만료 정책을 가진 사용자 데이터 저장 문제다.**

첫 버전은 개인 소유 캐시를 권한다. 예시 키:

```text
owner_scope + semester_id + server_verified_audio_digest
            + model_revision + pipeline_version + language + decode_config_hash
```

클라이언트가 보낸 해시를 검증 없이 신뢰하지 않는다. 서버 또는 신뢰하는 워커가 실제 바이트의 digest를 계산한다. 미디어를 다시 인코딩하면 같은 강의라도 cache miss가 날 수 있으므로, 최초에는 정확한 바이트 중복 제거만으로 충분하다.

- `course_id`만으로 공유하거나, signed URL을 cache key로 쓰지 않는다.
- 확장이 전송한 수강 과목 ID, 이메일 도메인, 자료 ID는 서버가 신뢰할 수 있는 수강 증명이 아니다.
- 공유 캐시는 학교가 검증 가능한 권한 증명·공식 연동 또는 관리자가 통제하는 별도 공유 체계를 마련한 뒤 검토한다. 임의 설치자의 자기 신고만으로 강의 자막을 반환하지 않는다.
- 공유 기능을 도입한다면 과목 수강뿐 아니라 해당 영상의 공개·잠금·분반 제한까지 검증한다. 학기 동안 저장한다는 사실이 학기 동안 열람 권한을 보장하지는 않는다. 수강 철회·접근 취소와 사용자 업로드의 공유 캐시 오염을 처리해야 한다.
- `expires_at`은 요청마다 연장되는 180일이 아니라 **명시한 학기 종료일**로 고정한다. 유예기간을 넣는다면 사용자에게 별도로 보여준다.
- 만료 시 API 접근을 즉시 거부하고, 자막·음원·작업 payload·백업의 실제 삭제 기한을 따로 정한다. DB 행만 지우고 파일·백업을 남기지 않는다.
- 원본 음원은 성공 후 즉시 삭제를 기본으로 하고, 실패 진단용 보관도 동의된 짧은 기한으로 제한한다. 학기 전체 보관 대상은 자막이지 원본 강의 영상이 아니다.

용량 예시는 **실측이 아닌 가정 계산**이다. 1시간짜리 600개, 음원 64 kbps, 자막 파일당 500 kB를 가정하면:

| 항목 | 계산 | 예상 용량 |
| --- | --- | --- |
| 압축 음원 전체 보관 | `600 × 3600 × 64000 / 8` | 17.28 GB |
| 16 kHz·mono·16-bit PCM 전체 보관 | `600 × 3600 × 16000 × 2` | 69.12 GB |
| 자막 전체 보관 | `600 × 500000` | 0.30 GB |

파일 복제·인덱스·백업 비용은 제외한 십진 단위다. 음원 수·길이가 두 배면 용량도 두 배다. RTF를 가정상 0.25로 놓으면 600시간 처리에 150 워커 시간이 필요하지만, 실제 처리량은 Mac에서 측정해야 한다. 결론은 큰 자막 DB보다 **음원 보관을 짧게 하고 작업 대기를 관리하는 것**이 우선이라는 뜻이다.

## 5. Telegram·Discord 알림: 전송보다 수집 계약이 먼저

### 5.1 무엇을 알릴지 분리

| 이벤트 | 원천 후보 | 브라우저 종료 중 처리 |
| --- | --- | --- |
| AI 자막 생성 완료 | Go 작업 완료 이벤트 | 서버만으로 가능 |
| 이미 동기화한 과제 마감 알림 | 개인 마감 snapshot + 서버 scheduler | 가능하나 마지막 동기화 이후 변경은 모름 |
| 새 과제·마감 변경 | 로그인된 LMS의 assignment/planner 응답 비교 | 새 조회가 없으면 발견 불가 |
| 새 공지 | 실제 학교에서 확인한 Canvas 공지 API | 공식 서버 연동 없이는 브라우저 수집 중단 시 발견 불가 |
| 출석 미완료 | 학교 출석 시스템의 검증된 상태 | 현재 Canvas 완료 정보로 추정하지 않음; 첫 버전 제외 |

Canvas에는 공지·planner API와 Live Events 자료가 존재한다.[R11][R12][R13] 하지만 이 확장이 학교 Live Events를 구독할 권한을 가진다는 근거는 없다. 브라우저에서 보이는 알림 배지나 toast를 긁는 것보다 **같은 출처의 허용된 GET 응답을 투영해 snapshot을 비교**하는 방식을 권한다.

공지 API는 과목 context와 조회 권한을 확인해야 한다. 기본 날짜 범위나 `latest_only`에 의존하면 놓친 공지를 모두 복구한다는 보장을 할 수 없다. 게시 날짜 기반의 최근 구간 조회만으로 오래된 공지 수정까지 감지한다고 약속하지 않는다.[R11] Planner의 `new_activity`도 uniDock 발송 이력은 아니므로 자체 baseline을 둔다.[R12] 공지 레이어 재출현은 신규 공지 이벤트로 취급하지 않는다.

### 5.2 수집 방식 비교

| 방식 | 세션 취급 | 장점 | 한계 / 권고 |
| --- | --- | --- | --- |
| 로그인된 LMS 탭에서 수집 | 세션은 브라우저 안에 유지 | 현재 구조와 가장 잘 맞음 | 브라우저·탭·로그인 상태 의존; 첫 버전 |
| 서버가 학교 공식 OAuth/API로 수집 | 별도 학교 승인·토큰 계약 필요 | 브라우저 없이 신규 이벤트 발견 가능 | 학교 지원 여부 확인 후 별도 프로젝트 |
| Canvas Live Events 연동 | 기관 측 연동 조건 확인 필요 | 이벤트 기반 원천 가능 | 일반 학생 확장의 기본 전제로 삼지 않음 |
| 학교 계정 쿠키를 Mac에 복사해 상시 조회 | 로그인 비밀 외부 저장 | 겉보기 자동화는 쉬움 | 현재 제품 경계와 충돌하므로 권하지 않음 |
| LMS 이메일 전달 | 메일 접근·별도 처리 필요 | 브라우저와 다른 수집 경로 | HTML·지연·중복·누락 계약이 추가됨; 후순위 |

처음에는 LMS 진입·다시 활성화·명시적 새로고침에 수집하고, 필요하면 보수적인 주기 조회를 추가한다. `chrome.alarms`는 worker를 깨울 수 있지만 로그인 세션이나 실행 중인 브라우저를 대신하지 않으며 정확한 실시간 알림을 보장하는 시계도 아니다.[R9] 알림을 켰을 때만 scheduler를 사용하고, 로그인 오류는 재로그인 안내로 전환한다.

UX에는 `마지막 LMS 동기화`, `현재 수집 가능/로그인 필요/탭 필요`, `알림 전송 연결 상태`를 별개로 표시해야 한다. **Telegram 연결 성공을 LMS 감지 성공으로 보여주면 안 된다.**

### 5.3 Telegram 연동 UX

사용자에게 BotFather 토큰이나 chat ID를 입력시키지 않는다.

1. 설정에서 `Telegram 연결`을 누른다.
2. Go 서버가 현재 서비스 계정에 귀속된 짧은 유효기간의 일회용 nonce를 발급한다.
3. `t.me/<bot>?start=<nonce>`를 열거나 QR로 표시한다.
4. 사용자가 봇에서 시작한다. 서버가 `/start`의 nonce와 chat을 연결 후보로 기록한다.
5. 확장으로 돌아와 대상 확인 후 연결을 확정한다. 이미 사용됐거나 만료된 nonce는 거부한다.
6. `테스트 알림`을 사용자가 누르고, 이후 종류·방해금지 시간을 설정한다.

Telegram의 start deep link는 공식 기능이며 payload 길이·문자 제약이 있다.[R10] nonce에 LMS ID·이메일을 담지 않는다. webhook 수신에는 공식 `secret_token` 검증을 적용하고 중복 update를 처리한다.[R14] 개인 알림은 private chat부터 지원한다.

연결 상태는 `미연결 / 연결 대기 / 연결됨 / 봇 차단·재연결 필요`로 구분한다. 연결 해제 시 서버의 발송 대상과 대기 알림을 제거한다. 학교 계정 전환 시 기존 수강 snapshot을 새 계정에 자동 재사용하지 않는다.

### 5.4 Discord 연동 UX

권고는 **개인용 서버의 비공개 채널 + OAuth `webhook.incoming`**이다. 공식 OAuth 흐름에서 사용자가 채널을 선택하고 서버가 webhook을 얻을 수 있다.[R15] raw webhook URL 붙여넣기를 일반 사용자의 기본 흐름으로 삼지 않는다.

연결 과정은 `Discord 연결 -> 서버/채널 선택 -> 대상 확인 -> 테스트 알림`으로 한다. OAuth state를 서비스 로그인 세션에 묶어 검증하고, client secret·webhook token은 서버에만 둔다. 새 연결 시 이전 webhook 정리와 중복 연결도 처리한다.

**채널 webhook은 개인 DM이 아니다.** 채널 열람자가 알림 내용을 볼 수 있음을 연결 확인 화면에 보여준다. DM이 필수라면 별도 bot 설치·사용자 식별·DM 수신 가능성 검증이 필요한 다른 범위로 취급한다.

발송은 `wait=true`로 응답을 확인하고 `allowed_mentions`를 제한해 강의 제목 등에 포함된 문자열이 대량 mention이 되지 않도록 한다.[R16] Telegram은 개인 알림에 바로 맞고 Discord는 수신 채널 선택이 추가되므로, 둘 다 동시에 만들기보다 Telegram을 먼저 권한다.

### 5.5 중복·누락·변경 처리

권고 서버 흐름:

```text
LMS에서 완전한 snapshot 수집
 -> 계정·origin 확인
 -> 최소 이벤트로 투영
 -> 이전 baseline과 비교
 -> 이벤트와 outbox를 같은 DB transaction으로 저장
 -> 대상별 발송
 -> 발송 결과·재시도 상태 기록
```

- **첫 연결은 baseline만 생성**한다. 과거 모든 공지를 신규로 보내지 않는다. 이후 과목 추가도 해당 과목 baseline부터 시작한다.
- 불완전한 페이지네이션·timeout·권한 오류를 빈 목록으로 취급하지 않는다. 성공한 전체 snapshot만 baseline을 교체한다.
- 다중 탭의 중복 수집과 늦게 도착한 snapshot을 구분한다. 계정 범위의 수집 담당 탭과 collection revision을 두고, 서버도 이전 revision이 최신 상태를 덮지 못하게 한다.
- 공지·과제 키는 계정 범위 + 유형 + 대상 식별자 + 의미 있는 revision으로 구성한다. 마감 알림 키에는 due timestamp와 알림 offset을 포함해 마감 변경 시 예약을 교체한다.
- 동일 항목을 여러 번 수신해도 이벤트 생성은 unique constraint로 한 번만 한다. 알림 전송은 네트워크 응답 유실 때문에 **정확히 한 번 배달**을 약속하지 않는다.
- 429의 재시도 지시를 따르고 transient 오류에 backoff를 적용한다. 삭제된 webhook·차단된 봇은 계속 재시도하지 않고 재연결 상태로 바꾼다.
- 오래된 마감 알림은 복구 후 몰아서 보내지 않는다. 이벤트별 발송 유효기간과 digest 정책을 둔다.

기본 메시지는 `새 공지 2건`, `마감 예정 과제 1건`처럼 최소 정보로 권한다. 제목·마감·정규 LMS 링크를 넣는 상세 모드는 별도 동의 대상으로 둔다. signed LTI 링크·세션 query·공지 전체 본문은 보내지 않는다. 렌더링 시 Telegram 포맷 문법과 Discord mention을 각각 안전하게 처리한다.

## 6. 정책과 코드 경계 변경

현행 `AGENTS.md`의 “Keep full API responses, tokens, cookies, signed LTI URLs, one-use handles, and labels out of storage.”는 명시적 요구사항이다. 현재 허용하는 로컬 저장 항목도 제한되어 있다. 이 보고서는 이를 몰래 우회하는 구현이 아니라, **새 기능을 위해 변경해야 할 계약**을 제안한다.

| 신규 데이터/동작 | 권고 경계 | 구현 시 함께 바꿀 부분 |
| --- | --- | --- |
| 팝업 설정 | boolean·버전만 local 저장 | 설정 store, clear-data, 정책 문서 |
| 서비스 인증 | LMS 자격증명과 분리, 기기별 회수 가능 | 로그인/기기 연결, 저장 allowlist, clear-data |
| 음원 업로드 | 사용자가 명시적으로 요청한 제한된 파일 | API 스키마, 동의 UX, host/CSP, 보관·삭제 고지 |
| 학기 자막 보관 | 개인 소유, 고정 만료일 | 서버 접근 검사, deletion worker, 백업 정책 |
| 알림 baseline | 원본 응답 아닌 최소 식별자·revision | 계정 분리, 보관 기간, 동기화 상태 |
| Telegram/Discord 연결 | chat/webhook 정보는 서버 보관 | 암호화·회수·연결 해제·발송 동의 |
| 관측성 | 정적 오류 코드·작업 시간·queue 길이 | 로그 redaction, 기존 analytics와 데이터 경로 분리 |

공통 변경 대상은 `README.md`, `public/privacy.html`, `documentation/SECURITY-REVIEW.md`, `wxt.config.ts`, `scripts/package-release.mjs`다. 개인정보 페이지 변경 시 `npm run pages:sync`로 생성물을 갱신한다. 원격 코드를 실행하거나 모든 사이트 권한을 추가할 필요는 없다.

현재 자막 화면의 동기식 감지 결과와 서버 작업 상태를 하나의 과도한 union에 섞기보다, 기존 `detectCaptions`와 별도의 생성 job client를 두는 편이 낫다. 메시지 계약을 바꿀 때 `src/protocol.ts`, `src/protocol-fields.ts`, dispatcher, UI validation을 함께 검토한다.

알림 구현에서는 `src/api/client.ts:89`의 planner 조회와 `:115`의 과목별 과제 조회를 연결 후보로 삼는다. `src/domain-items.ts:3`의 공개 화면 모델은 알림용 안정 식별자를 제공하는 계약이 아니므로 제목 비교로 중복 제거하지 않는다. `entrypoints/lms.content.ts:847`의 기존 조회는 sidepanel 발신자를 검사하므로, background scheduler를 추가할 때는 별도의 좁은 메시지 계약이 필요하다. 화면용 모델에 raw LMS 객체를 확장하는 대신 content-script 경계에서 최소 알림 이벤트를 만든다.

## 7. 검증 계획과 구현 착수 판단

### 팝업

DOM 구조·열린 팝업의 클릭 성공·wrapper 유지 여부는 사용자가 확인했다. 구현에서는 생성 직후 클릭과 wrapper 내부의 후속 공지 처리를 검증한다. 관련 unit test와 합성 LMS E2E, `npm run check`, 설치된 production 확장의 실제 LMS 검증을 수행한다. 다른 dialog 오클릭이 한 번이라도 나오면 selector 범위를 좁힌다.

### AI 자막

- 동일 파일의 중복 요청, 다른 사용자의 결과 조회 거부.
- 업로드 중단·용량 초과·손상 파일·긴 무음·장시간 음원.
- 워커 종료·Mac 재시작·네트워크 단절·lease 만료·늦은 완료.
- 취소/삭제와 완료 경합, 학기 만료 뒤 재조회와 백업 삭제.
- 탭 이동·로그아웃·학교 계정 전환 후 잘못된 자막 표시 방지.
- 모델·pipeline 버전 변경 시 cache 분리, 원본·AI 출처 구별.

### 알림

- 최초 baseline 무발송, 신규·수정·마감 변경의 구별.
- 부분 snapshot 실패 시 baseline 유지, 다중 탭·다중 기기 중복.
- timezone·방해금지·브라우저 종료·오래된 snapshot 표시.
- OAuth state 불일치, nonce 재사용·만료, webhook 위조.
- 429·봇 차단·webhook 삭제·응답 유실·연결 해제 중 발송 경합.

**실무 권고:** P0를 독립적인 작은 변경으로 먼저 마친다. 다음으로 “대표 강의 음원을 얻을 수 있는가”와 “내 Mac mini에서 쓸 만한 한국어 자막이 나오는가”를 별도 PoC로 통과시킨다. 그 결과가 나온 뒤 서버 API·보관·인증을 확정한다. 알림에서는 AI 생성 완료를 첫 이벤트로 붙이면 LMS 감지 문제와 전송 UX를 분리해 검증할 수 있다.

## 8. 공식 레퍼런스

아래 링크는 2026-10-20 조사 시 열람한 자료다. 기능의 근거이지 학교 환경에서의 동작 증거는 아니다. 저장소 README는 바뀔 수 있으므로 구현 시 선택 버전과 commit을 고정해야 한다.

- [R1] Chrome content scripts: https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts — 실행 시점·isolated world·DOM 접근.
- [R2] MDN MutationObserver: https://developer.mozilla.org/en-US/docs/Web/API/MutationObserver — DOM 변경 관찰과 해제.
- [R3] Chrome tabCapture: https://developer.chrome.com/docs/extensions/reference/api/tabCapture — 사용자 호출 기반 캡처 및 버전 제약.
- [R4] whisper.cpp: https://github.com/ggml-org/whisper.cpp — Apple Silicon 추론 경로와 CLI 구현 참고.
- [R5] MLX Whisper: https://raw.githubusercontent.com/ml-explore/mlx-examples/main/whisper/README.md — Python 추론·모델 선택·word timestamps.
- [R6] Argmax Swift / WhisperKit: https://github.com/argmaxinc/argmax-oss-swift — 기존 WhisperKit 주소가 조사 시 이 저장소로 연결됨.
- [R7] faster-whisper: https://github.com/SYSTRAN/faster-whisper — CTranslate2 기반 추론과 CUDA 중심 GPU 안내.
- [R8] Chrome service worker lifecycle: https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle — 비상주 worker와 상태 지속성.
- [R9] Chrome alarms: https://developer.chrome.com/docs/extensions/reference/api/alarms — 예약 실행·절전·지연 조건.
- [R10] Telegram bot features: https://core.telegram.org/bots/features#deep-linking — 시작 파라미터를 이용한 계정 연결.
- [R11] Canvas Announcements: https://developerdocs.instructure.com/services/canvas/resources/announcements — 공지 조회 API.
- [R12] Canvas Planner: https://developerdocs.instructure.com/services/canvas/resources/planner — planner 목록 및 상태.
- [R13] Canvas Live Events: https://developerdocs.instructure.com/services/canvas/data-services/live-events — 기관 연동 검토 출발점.
- [R14] Telegram Bot API: https://core.telegram.org/bots/api#setwebhook — webhook secret, 업데이트·발송 계약.
- [R15] Discord OAuth2: https://docs.discord.com/developers/topics/oauth2 — `webhook.incoming`과 채널 선택 흐름.
- [R16] Discord Webhook: https://docs.discord.com/developers/resources/webhook — 실행 응답·`wait`·mention 제어.

아래는 2026-10-21 추가 조사 자료다. [R18]~[R21]은 블로그·커뮤니티·모델 카드의 자체 보고이며 독립 검증된 벤치마크가 아니다.

- [R17] MDN AudioEncoder: https://developer.mozilla.org/en-US/docs/Web/API/AudioEncoder — Chrome 94+, 코덱 지원은 `isConfigSupported()`로 런타임 확인.
- [R18] Simon Willison, whisper large-v3-turbo: https://simonwillison.net/2024/Oct/1/whisper-large-v3-turbo-model/ — 809M, 1.6 GB, M2 Ultra mlx-whisper 처리 속도 보고.
- [R19] Qwen3-ASR-1.7B 모델 카드: https://huggingface.co/Qwen/Qwen3-ASR-1.7B — 한국어 포함 30개 언어, Apache-2.0, ForcedAligner 5분·11개 언어.
- [R20] MLX 포팅: https://github.com/moona3k/mlx-qwen3-asr , https://www.mintlify.com/OminiX-ai/OminiX-MLX/asr/qwen3-asr — 메모리 사용량, M4 Max 처리 속도 보고.
- [R21] BuzzASR Korean: https://huggingface.co/BuzzASR/korean — Whisper large-v3 기반 한국어 fine-tune, 자체 보고 CER.

외부 프로젝트는 전체 서버를 복사하기보다 **추론 adapter와 플랫폼 연동 패턴의 참고**로 활용할 것을 권한다. 제품의 LMS 접근·권한·학기 삭제 정책은 별도로 설계해야 한다.
