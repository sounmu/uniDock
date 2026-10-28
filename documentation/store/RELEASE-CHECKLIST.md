# 배포 절차 및 남은 입력

상태(2026-10-28): 0.4.0 배포 준비 중. 0.4.0부터 배포 ZIP에 순차 자동 재생과 AI 자막 생성을 포함합니다. Chrome Web Store에는 아직 등록·제출하지 않았으므로 첫 등록 기준으로 정리합니다. 0.3.0은 `main`에 병합됐고(PR 6), 0.2.0·0.2.1은 GitHub 릴리스로만 배포했습니다.

## 준비된 산출물

- release/uniDock-0.4.0-chrome-mv3.zip: 자동 재생·AI 자막을 포함한 배포 후보 (`npm run release`로 생성, 저장소에는 포함하지 않음)
- release/inventory.json: ZIP 및 포함 파일 SHA-256
- public/privacy.html: 앱 내 개인정보 페이지 및 공개 게시용 원본 (기준일 2026-10-28, 적용 버전 0.4.0. 확인되지 않은 서버 처리 항목은 본문에서 빠져 있음)
- docs/privacy.html, docs/index.html: GitHub Pages 배포용 사본 (`npm run pages:sync`로 갱신, `pages:check`로 일치 확인)
- public/icons, store/assets: 새 유리 효과 로고 아이콘과 홍보(promo.png)·샘플 화면(assignments.png, recordings.png, schedule.png)
- LISTING.md: 등록 설명, 권한 사유, 데이터 처리 고지 초안 (0.4.0 범위 반영, 배포자 TODO 포함)
- ../SECURITY-REVIEW.md: 범위, 수정 사항, 잔여 위험 (0.4.0은 2026-10-28 절)

## 재현

```sh
npm ci
npm run release        # .env.local에 UNIDOCK_PLAYBACK=1, UNIDOCK_AI_CAPTIONS=1, UNIDOCK_CAPTION_SERVER=<자막 서버 origin> 필요
npm run contract:check  # Python 3.10+ 및 읽기 전용 ../ku-lms-cli가 있을 때
npm run store:assets   # 개발용: macOS Chrome, sips 필요. 개인 프로필 미사용
```

`npm run release`는 `notices` 재생성 → `UNIDOCK_RELEASE=1`로 `check`(pages 검사·lint·typecheck·테스트·빌드) → `npm audit` → `scripts/package-release.mjs`(manifest·ZIP allowlist 검사, ZIP·inventory 생성) 순서로 실행합니다. `UNIDOCK_RELEASE=1`은 개발용 manifest `key`를 넣지 않게 합니다. 패키징은 두 기능 플래그가 켜져 있지 않거나, 자막 서버가 E2E용 테스트 origin이거나, 번들에 그 테스트 origin이 남아 있으면 실패합니다. 자막 서버 origin은 공개 문서·UI·이슈에 적지 않고 `.env.local`에만 둡니다.

`npm run`은 `~/.npmrc` 등의 npm 설정을 `npm_config_*` 환경변수로 하위 명령에 넘깁니다. 전역 `allow-scripts` 설정이 있으면 npm 11이 하위 `npm audit`을 `EALLOWSCRIPTS`로 중단하므로, `release` 스크립트는 audit 단계에서만 `env -u npm_config_allow_scripts`로 이 변수를 제거합니다. 전역 설정은 바꾸지 않습니다.

분석 토큰은 루트 `.env.local`의 `VITE_POSTHOG_KEY`를 빌드 시 읽습니다. 이 파일은 CI/다른 개발 환경에 자동 전달되지 않습니다. `npm run build`는 `.output/`만 갱신하므로 토큰을 추가·변경한 후의 배포 ZIP은 `npm run release`로 다시 생성해야 합니다. 테스트용 토큰으로 배포하지 않습니다. 아래 PostHog 운영 설정을 마치지 못하면 토큰 없이 빌드해 통계를 끈 채 배포합니다.

ZIP 업로드 후 파일을 수정했다면 반드시 release를 다시 실행하고 해시를 갱신합니다. ZIP 루트에 manifest.json이 있어야 합니다. 소스 프로젝트 전체를 업로드하지 않습니다.

## 0.4.0 manifest와 권한

- 기능 권한: `sidePanel`, `activeTab`, `scripting`, `downloads`, `storage`에 `alarms`(자동 재생), `declarativeNetRequestWithHostAccess`·`identity`(AI 자막)를 추가. 정확한 목록은 `package-release.mjs`가 강제합니다.
- 상시 호스트: `mylms.korea.ac.kr`, `canvas.korea.ac.kr`, `kucom.korea.ac.kr` (0.3.0과 동일).
- 선택 호스트(`optional_host_permissions`): `https://lms.korea.ac.kr/*`(팝업 자동 닫기), `https://korea-cms-object.cdn.gov-ntruss.com/*`(AI 자막의 음성 취득, ‘음성 보내기’를 누를 때만 요청). 설치·업데이트 때 묻지 않습니다.
- CSP `connect-src`: PostHog EU, 강의 영상 CDN, 자막 서버 origin 하나.
- 콘텐츠 스크립트 선언: `content-scripts/lms.js`와 `content-scripts/player.js`(모든 프레임, LMS 두 호스트와 `kucom.korea.ac.kr/em/*`). `content-scripts/lms-popup.js`는 ZIP에 포함되지만 manifest에 선언하지 않고 opt-in 후 런타임 등록합니다.
- manifest `key`, `oauth2`는 없어야 합니다(`package-release.mjs`가 강제).
- 상시 권한과 콘텐츠 스크립트가 늘어 기존 설치에 업데이트 권한 경고가 뜰 수 있습니다. 첫 스토어 등록에는 해당하지 않지만 GitHub 릴리스 사용자에게는 안내가 필요합니다.
- 대시보드 권한 사유에 `alarms`, `declarativeNetRequestWithHostAccess`, `identity`, 선택 CDN 호스트 줄과 `storage`의 재생·자막 세션 용도가 추가됐습니다(LISTING.md 표).

## 0.4.0 확인

아래 항목은 아직 하지 않았습니다. 합성 E2E(`npm run test:e2e:full`, `test:e2e:playback`, `test:e2e:ai-captions`)는 실제 LMS·CDN·자막 서버·Google 로그인을 대신하지 않습니다.

- [ ] `package.json`·manifest 버전 0.4.0, 업데이트 안내(`entrypoints/updates/index.html`)를 0.4.0 변경으로 갱신
- [x] 개인정보처리방침 적용 버전 0.4.0으로 갱신하고 Pages 사본 동기화(`pages:check` 통과)
- [ ] 서버의 계정 정보·사용 기록 보관 기간, 계정 삭제·자막 삭제 요청 절차, 운영자 접근 통제, 모델 학습 미사용 확약, 처리 위탁 업체·저장 지역을 확정해 개인정보처리방침에 추가하고 LISTING의 배포자 TODO를 채운 뒤 `npm run pages:sync` (0.4.0 GitHub 릴리스는 이 항목 없이 배포)
- [x] LISTING의 0.4.0 범위, 기능 목록, 권한 사유, 음성·Google 계정 데이터 공개 반영
- [ ] 실제 `.env.local`로 `npm run release`를 끝까지 실행하고 manifest에 `key`가 없는지, CSP의 자막 서버 origin이 운영 서버인지 확인
- [ ] 0.3.0 설치본 위에 0.4.0을 올려 Chrome의 권한 경고 문구와 재승인 흐름 확인

AI 자막 (실제 Chrome, 압축 해제한 `.output/chrome-mv3`):

- [ ] 설정의 ‘AI 자막 서버’에서 실제 Google 계정 로그인 → 표시 이메일·이번 주 남은 횟수 → 로그아웃 → 다시 로그인 → 모든 기기에서 로그아웃
- [ ] 자막 없는 실제 KU 강의에서 ‘AI 자막 생성’ → 확인 화면 문구 → ‘음성 보내기’ 때 CDN 권한 프롬프트 허용·거절(거절 시 요청 없음) → 업로드 → 대기 → ‘AI 생성’ 자막 표시 → TXT·JSON 다운로드
- [ ] 네트워크 탭에서 CDN 요청이 음성 범위만 받는지, 자막 서버 요청에 LMS 쿠키·URL·과목 ID·강의 제목·KU 콘텐츠 ID가 없는지 확인
- [ ] 진행 중 패널 닫기·다시 열기, 탭 이동·닫기 취소, 같은 강의 재요청 시 기존 작업 표시, 작업 종료 후 `chrome.declarativeNetRequest` 세션 규칙이 남지 않는지 확인
- [ ] 주 7회 초과 시 안내와 초기화 시각, 처리 서버 꺼짐 안내
- [ ] ‘로컬 데이터 모두 삭제’ 후 `unidock.caption-session.v1`·`unidock.caption-install-salt.v1`·`unidock.caption-active-job.v1`이 없고 다시 로그인을 요구하는지 확인
- [ ] UI·콘솔·오류 문구 어디에도 자막 서버 hostname이 보이지 않는지 확인

순차 자동 재생 (실제 Chrome, 선택한 검증 강의에서만):

- [ ] 기본 꺼짐, 영상 체크 순서대로 보이는 전용 탭에서 1x 재생, `ended` 후 다음 영상 이동, 체크하지 않은 영상은 재생하지 않음
- [ ] 전용 탭을 숨기거나 다른 탭으로 옮기면 재생하지 않는지, 로그인 만료 시 중단하고 명시적 재개만 되는지
- [ ] 브라우저·service worker 재시작 후 자동 재개하지 않는지, 패널의 재생 상태 삭제와 ‘로컬 데이터 모두 삭제’ 후 `unidock.playback.v2`·`unidock.playback.salt`가 없는지
- [ ] 기능을 켜지 않은 상태에서 `player.js`가 LMS·kucom 프레임에 주입돼도 재생·탐색을 바꾸지 않는지, 콘솔 오류가 없는지
- [ ] 실제 LMS의 시청·출석 기록 반영 여부를 확인하고, 확장이 완료·출석 API를 호출하지 않는지 네트워크 탭으로 확인
- [ ] Chrome 114와 현재 안정 버전에서 두 기능 로드와 위 핵심 흐름 확인
- [ ] 스토어 이미지에 AI 자막·자동 재생 화면이 필요한지 결정하고, 넣는다면 가상 데이터로 다시 생성

## 0.3.0 확인 (남은 항목은 0.4.0에도 적용)

2026-10-23 로컬 검증: `npm run check`(771 tests), 커버리지 80% 기준, production Chromium E2E 25 passed / 자동 재생 전용 8 skipped, PR 6 CI `verify` 통과. `scripts/package-release.mjs`의 manifest·ZIP allowlist 검사를 통과했고, `npm run release` 전체(notices·audit 포함)는 최종 ZIP을 만들 때 다시 실행합니다. 아래 실제 LMS·실제 Chrome 확인은 아직 하지 않았습니다. E2E는 합성 HTTPS LMS를 쓰며, 선택 권한은 headless에서 프롬프트에 응답할 수 없어 `chrome://extensions`의 developerPrivate API로 부여합니다.

- [x] 업데이트 안내(`entrypoints/updates/index.html`)를 0.3.0 변경으로 갱신하고 E2E 제목 확인
- [x] 개인정보처리방침 적용 버전 0.3.0, Pages 사본 동기화(`pages:check` 통과)
- [x] LISTING의 0.3.0 범위, 기능 목록, 권한 사유(선택 호스트·팝업 설정 저장) 반영
- [ ] `.output/chrome-mv3`를 압축 해제 상태로 로드한 실제 Chrome에서 팝업 자동 닫기: 기본 꺼짐, 켤 때 권한 프롬프트 허용·거절, 빠른 끄기→켜기 후 켜짐 유지, 이미 열린 포털 탭에 즉시 적용, `chrome://extensions`에서 권한 회수 시 꺼짐, 브라우저 재시작 후 등록 유지, 로컬 데이터 삭제 후 권한 반납
- [ ] 실제 `lms.korea.ac.kr`에서 공지 팝업과 미참여 설문 안내만 닫히고 ‘로그아웃’, ‘오늘 하루 보지 않기’, 다른 컨트롤은 건드리지 않는지, ‘설문 나가기’ 이후 LMS 동작
- [ ] 실제 과목의 게시판 영상: 녹화 강의 목록 표시, ‘강의 열기’로 KU 플레이어 탭이 열리는지, 그 탭에서 자막 감지, ‘LMS 게시판에서 보기’ 경로, 글이 많은 과목에서 20초 안에 완료되는지와 실패 시 ‘게시판 영상을 불러오지 못해…’ 안내
- [ ] 플레이어를 LMS 밖에서 열었을 때 시청 기록 처리 차이 확인(게시판 백업 영상은 출석 항목이 아니라는 가정)
- [ ] 실제 Planner 응답에서 일정 과제·공지·기타 구분(토론은 과제로 분류)
- [ ] Chrome 114와 현재 안정 버전에서 위 항목 중 선택 권한·런타임 등록 경로 확인
- [x] 샘플 화면을 실제 패널 구성요소로 다시 생성: 과제, 주차학습·게시판 녹화 강의, 일정 과제·공지 구분 (`node scripts/store-assets.mjs`)
- [ ] 스토어 이미지(promo.png, assignments.png, recordings.png, schedule.png)와 새 아이콘이 실제 0.3.0 패널과 일치하는지 실제 Chrome에서 비교

## 제출 전 필수 (아직 완료되지 않음)

계정·공개 정책:

- [ ] 배포자 표시명, 공개 지원 이메일/지원 URL 결정 및 스토어 계정 연락처 등록 (LISTING의 ‘미정’ 항목). 개인정보처리방침은 문의처를 스토어 등록 페이지의 지원 연락처로 안내하므로 본문 수정은 필요 없음
- [ ] GitHub Pages를 `main`의 `/docs`로 설정하여 공개 HTTPS URL에 게시하고, 비로그인 브라우저에서 `/privacy.html`이 ‘적용 버전: 0.4.0’으로 보이는지 확인한 뒤 LISTING과 대시보드에 URL 입력 ([배포 안내](../../README.md#개인정보처리방침-github-pages-배포))
- [ ] Chrome Web Store 개발자 등록 및 계정 보안/2단계 인증 요구 충족. 비용 지급·계정 설정은 배포자 수행

PostHog 사용 통계 (공개 정책의 약속과 일치해야 함):

- [x] 2026-10-04 운영 토큰의 합성 SDK `/batch/` 요청 HTTP 200 확인 (`scripts/verify-analytics-live.mjs`)
- [x] 실제 PostHog 이벤트 도착 확인 (사용자 확인). 보관 설정·전체 속성·그래프 검증을 뜻하지 않음
- [ ] 최종 배포 ZIP을 해당 EU 프로젝트 토큰으로 재생성하고 재로드하여 수신 확인. 개인 API 키는 확장에 포함하지 않음
- [ ] PostHog의 IP 폐기와 GeoIP/자동 기능 비활성 확인, 원시 이벤트 최대 90일 보관·삭제 정책 설정 및 검증. 해당 기능을 제공하지 않는 플랜이면 서버측 만료 삭제 운영을 마련하기 전 수집을 활성화하지 않음
- [ ] 지원 연락처를 통한 설치 ID별 원격 이벤트 삭제 절차 확인. 로컬 삭제와 원격 삭제의 차이를 고지
- [ ] 동의 전 네트워크/분석 ID 없음, 거절 후 기능 이용, 동의 후 고정 이벤트(0.3.0에서 `filter_kind` 추가), 철회/재시작/모든 데이터 삭제 후 중단 확인
- [ ] 실제 PostHog 프로젝트에서 가상 데이터로 속성·DAU/WAU/MAU·리텐션 대시보드 확인. [설정 안내](../ANALYTICS.md#대시보드-구성)

실제 LMS·브라우저 (이전 버전부터 남은 항목):

- [ ] 실제 LMS의 로그인 전/후, 403·세션 만료, 과제·일정·강의 여러 페이지, 안전한 탭 열기 확인
- [ ] 실제 주차학습·게시판/공지에서 PDF·PPTX·PPT 첨부파일이 하나의 강의 자료 목록에 표시되는지 확인. 학교 전용 외부 도구·본문 링크·답글 첨부는 Canvas 첨부 메타데이터 범위와 구분
- [ ] 실제 LTI 자막/다운로드·권한 미승인·자막 없음·cross-origin iframe·파일 내용 검증
- [ ] Chrome 114와 현재 안정 버전의 Side Panel, activeTab, MAIN/documentIds, 다운로드 동작 확인
- [ ] 기관/강의 자료 이용 조건과 자막 저장 권한 확인. 대학 공식 제품으로 오인시키는 이름·로고·설명 사용 금지

대시보드 입력:

- [ ] LISTING의 짧은 설명·상세 설명·단일 목적·권한 사유·데이터 공개 항목을 그대로 입력하고, 음성 전송과 Google 계정 정보를 데이터 공개 항목에 빠짐없이 신고했는지 확인
- [ ] 배포자가 LISTING의 데이터 항목·Limited Use 선언·국가/배포 대상·지원 연락처를 확인
- [ ] 아래 심사용 로그인 제한 설명을 제출하고, 심사에서 요구하는 접근 수단을 확보

## 승인 후

- [ ] 스토어 설치본에서 설정 화면 버전 0.4.0, 개인정보처리방침 링크, 자동 재생·통계·팝업 닫기 기본 꺼짐, AI 자막 로그아웃 상태 확인
- [ ] 첫 등록이므로 설치 사용자에게 `NEW` 배지·업데이트 안내가 뜨지 않는 것이 정상. 다음 버전부터 스토어 업데이트 후 새 탭 없이 배지와 패널 알림이 한 번 표시되고 열린 LMS 탭이 새로고침 없이 조회되는지 확인
- [ ] GitHub 릴리스 `v0.4.0`에 같은 ZIP과 `inventory.json`을 첨부하고 해시가 스토어 업로드본과 같은지 확인

## 심사자 안내 초안

이 제품은 로그인된 고려대 LMS 세션을 사용합니다. 개발자에게 비밀번호를 보내거나 확장에 자격 증명을 입력하지 않습니다. 회원 가입은 대학의 권한 관리에 따르므로 공개 테스트 계정이 현재 없습니다. 실제 LMS 접근 없이는 핵심 조회 기능을 완전히 검증할 수 없습니다. 배포 전 기관 정책에 맞는 심사용 접근 방법 또는 심사팀과 합의한 검증 자료가 필요합니다. 대학 사용자 비밀번호·쿠키를 ZIP/설명/영상에 넣지 않습니다.

오프라인 샘플 이미지는 실제 사이드 패널 구성요소와 가상 데이터로 만든 것이며 production에 숨겨진 심사 전용 동작이나 원격 데모 모드는 없습니다. 자막은 사용자가 직접 연 플레이어에서 감지합니다. 순차 자동 재생은 사용자가 체크한 영상만 보이는 전용 탭에서 정상(1x) 속도로 재생하며, 배속·숨긴 탭 재생·완료/출석 API 호출·keepalive는 없습니다. AI 자막은 자막이 없는 강의에서 사용자가 Google 계정으로 로그인하고 확인한 경우에만 현재 강의의 음성을 개발자의 자막 서버로 보냅니다. LMS 쿠키·URL·과목 ID·강의 제목은 보내지 않습니다. 심사에서 AI 자막을 확인하려면 자막 서버에 로그인할 수 있는 Google 계정이 필요합니다. **TODO(배포자): 심사용 Google 계정 허용 방법(허용 목록 등)을 정하고 여기에 적기.**

## 실제 제출 (이 작업에서는 수행하지 않음)

Developer Dashboard에서 새 항목 생성 → 위 ZIP 업로드 → 등록 설명/아이콘/홍보 이미지/화면 입력 → 권한 사유/데이터 고지/공개 정책 URL 입력 → 테스트 안내 및 배포 대상 확인 → 배포자가 최종 내용 검토 후 심사 제출. 승인 전에는 배포 완료로 공지하지 않습니다.

공식 참고 (2026-09-11 확인):

- https://developer.chrome.com/docs/webstore/publish
- https://developer.chrome.com/docs/webstore/images
- https://developer.chrome.com/docs/webstore/cws-dashboard-privacy
- https://developer.chrome.com/docs/webstore/program-policies/user-data-faq
- https://developer.chrome.com/docs/webstore/program-policies/limited-use
- https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements
