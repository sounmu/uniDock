# uniDock 0.1.0 보안 검토 — 2026-09-11

상태: **코드 수정 및 배포 후보 준비. 실제 LMS/Chrome 114/스토어 심사 검증은 남아 있음.** 독립 침투시험이나 보안 인증이 아니며 무결함 보장을 의미하지 않습니다.

## 범위와 방법

모든 src/entrypoints, Manifest, 빌드 설정, 패키지/lockfile, 메시지 흐름, 입력/출력 투영, API·페이지네이션, 탭 열기, 자막 DOM/MAIN 경계, 다운로드, 로깅·보관, 공급망과 최종 ZIP을 검토했습니다. 단위·계약·회귀 테스트 및 npm audit를 수행합니다. 참조 ku-lms-cli는 읽기 전용이며 env/비공개 discovery/사용자 세션은 조사하지 않았습니다.

보호 대상은 인증 세션, 내부 LMS ID, URL/LTI 파라미터, 과제·제출 상태, 자막 및 사용자 탭입니다. LMS 응답/Link, 페이지 DOM, MAIN world 값, extension 메시지는 신뢰하지 않습니다. LMS 서버와 브라우저 자체가 침해되지 않았다는 가정은 남습니다.

## 발견 및 수정

| ID | 심각도 | 문제 | 조치 |
| --- | --- | --- | --- |
| SEC-01 | 중간 | API JSON을 크기 제한 없이 읽어 메모리 고갈 가능 | 스트림을 읽으며 페이지당 2 MB에서 취소, Content-Length도 사전 검사. 전체 20초/100페이지·목록 10,000개 제한 유지 |
| SEC-02 | 중간 | 자막 대기 시간 초과 후 늦게 끝난 DOM 작업이 MAIN 읽기를 계속할 수 있음 | 시간 초과 플래그 검사로 후속 주입·처리를 막음. 이미 주입된 작업의 강제 종료를 보장하지는 않음 |
| SEC-03 | 중간 | 선언된 track src가 동일 출처 임의 GET endpoint일 수 있음 | 자막 확장자 vtt/srt/ttml/dfxp/smi 경로로 제한하고 명백한 변경/로그아웃 경로 차단. 외부 출처·리다이렉트 계속 금지 |
| SEC-04 | 중간 | MAIN의 중첩 caption getter를 실행할 수 있음 | own data descriptor로 배열 원소·label/lang/caption/cues/text를 읽어 일반 accessor 실행 방지 |
| SEC-05 | 배포 요건 | 로컬 데이터 처리 고지·개인정보 페이지·비공식 표시·아이콘·패키지 검사가 부족 | UI 고지, bundled privacy, 배포 문서, 자체 아이콘, 제한적인 ZIP allowlist·해시 검사 추가 |

각 코드 조치는 tests/security-review.test.ts에서 회귀 검증합니다. 기존 자막/메시지/호스트/GET/페이지네이션/만료 및 Python 계약 테스트도 유지합니다.

## 확인한 경계

- API 클라이언트는 내부에서 만든 GET 목록 endpoint만 허용하며 URL/메서드 프록시가 없습니다. 각 next Link는 동일 출처·동일 경로·허용 query만 통과합니다.
- content script는 확장 자신의 Side Panel 발신자만 처리합니다. 백그라운드 탭 열기는 확장 ID, 최상위 LMS 프레임, 현재 탭 URL, canonical LMS 경로를 검사합니다. 외부 메시징/웹 접근 리소스는 선언하지 않습니다.
- 원본 API 객체 대신 공개 필드만 전달합니다. React 텍스트 렌더링이며 innerHTML/eval/동적 원격 코드가 없습니다. extension CSP는 self 스크립트, object/connect/base/form 금지를 적용합니다. content script의 동일 출처 Fetch는 별도 실행 경계입니다.
- 쿠키 값을 읽는 코드·credential 입력·storage·telemetry 없음. 정적 이벤트 코드 로깅 하나만 존재. 명시적 TXT 내보내기 이외 지속 저장 없음.
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
