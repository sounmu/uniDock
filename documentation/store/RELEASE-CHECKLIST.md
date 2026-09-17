# 배포 절차 및 남은 입력

## 준비된 산출물

- release/uniDock-0.1.0-chrome-mv3.zip: production 전용 배포 후보
- release/inventory.json: ZIP 및 포함 파일 SHA-256
- public/privacy.html: 앱 내 개인정보 페이지 및 공개 게시용 원본
- docs/privacy.html, docs/index.html: GitHub Pages 배포용 사본 (`npm run pages:sync`로 갱신)
- public/icons, store/assets: 아이콘과 홍보/샘플 화면
- LISTING.md: 등록 설명, 권한 사유, 데이터 처리 고지 초안
- ../SECURITY-REVIEW.md: 범위, 수정 사항, 잔여 위험

## 재현

```sh
npm ci
npm run notices
npm run release
npm run contract:check  # Python 3.10+ 및 읽기 전용 ../ku-lms-cli가 있을 때
npm run store:assets   # 개발용: macOS Chrome, sips 필요. 개인 프로필 미사용
```

ZIP 업로드 후 파일을 수정했다면 반드시 release를 다시 실행하고 해시를 갱신합니다. ZIP 루트에 manifest.json이 있어야 합니다. 소스 프로젝트 전체를 업로드하지 않습니다.

## 제출 전 필수 (아직 완료되지 않음)

- [ ] 배포자 표시명, 공개 지원 이메일/지원 URL 결정 및 스토어 계정 연락처 등록
- [ ] `public/privacy.html`에 배포자 연락처를 넣고 `npm run pages:sync` 실행. GitHub Pages를 `main`의 `/docs`로 설정하여 공개 HTTPS URL에 게시하고 비로그인 브라우저에서 접근 확인 ([배포 안내](../../README.md#개인정보처리방침-github-pages-배포))
- [ ] Chrome Web Store 개발자 등록 및 계정 보안/2단계 인증 요구 충족. 비용 지급·계정 설정은 배포자 수행
- [ ] 실제 LMS의 로그인 전/후, 403·세션 만료, 과제·일정·강의 여러 페이지, 안전한 탭 열기를 확인
- [ ] 실제 LTI 자막/다운로드·권한 미승인·자막 없음·cross-origin iframe·파일 내용 검증
- [ ] Chrome 114와 현재 안정 버전의 Side Panel, activeTab, MAIN/documentIds, 다운로드 동작 확인
- [ ] 최종 스토어 이미지와 실제 UI 일치 확인. 실사용 화면은 반드시 가상 데이터 또는 완전히 비식별화한 자료로 제작
- [ ] 기관/강의 자료 이용 조건과 자막 저장 권한 확인. 대학 공식 제품으로 오인시키는 이름·로고·설명 사용 금지
- [ ] 배포자가 LISTING의 데이터 항목·Limited Use 선언·국가/배포 대상·지원 연락처를 확인
- [ ] 아래 심사용 로그인 제한 설명을 제출하고, 심사에서 요구하는 접근 수단을 확보

## 심사자 안내 초안

이 제품은 로그인된 고려대 LMS 세션을 사용합니다. 개발자에게 비밀번호를 보내거나 확장에 자격 증명을 입력하지 않습니다. 회원 가입은 대학의 권한 관리에 따르므로 공개 테스트 계정이 현재 없습니다. 실제 LMS 접근 없이는 핵심 조회 기능을 완전히 검증할 수 없습니다. 배포 전 기관 정책에 맞는 심사용 접근 방법 또는 심사팀과 합의한 검증 자료가 필요합니다. 대학 사용자 비밀번호·쿠키를 ZIP/설명/영상에 넣지 않습니다.

오프라인 샘플 이미지는 실제 ResultList와 공개 fixture로 만든 것이며 production에 숨겨진 심사 전용 동작이나 원격 데모 모드는 없습니다. 자막은 사용자가 직접 연 플레이어에서 감지하며 자동 재생·출석 처리는 하지 않습니다.

## 실제 제출 (이 작업에서는 수행하지 않음)

Developer Dashboard에서 새 항목 생성 → 위 ZIP 업로드 → 등록 설명/아이콘/홍보 이미지/화면 입력 → 권한 사유/데이터 고지/공개 정책 URL 입력 → 테스트 안내 및 배포 대상 확인 → 배포자가 최종 내용 검토 후 심사 제출. 승인 전에는 배포 완료로 공지하지 않습니다.

공식 참고 (2026-09-11 확인):
- https://developer.chrome.com/docs/webstore/publish
- https://developer.chrome.com/docs/webstore/images
- https://developer.chrome.com/docs/webstore/cws-dashboard-privacy
- https://developer.chrome.com/docs/webstore/program-policies/user-data-faq
- https://developer.chrome.com/docs/webstore/program-policies/limited-use
- https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements
