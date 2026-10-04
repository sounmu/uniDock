import type { ErrorCode } from "../../src/protocol";
export const messages: Record<ErrorCode, string> = {
  LOGIN_REQUIRED:
    "LMS 로그인이 필요합니다. LMS에서 로그인한 뒤 다시 조회하세요.",
  OPEN_LMS: "로그인한 LMS 탭을 선택한 뒤 조회하세요.",
  RELOAD_TAB:
    "LMS 탭과 연결되지 않았습니다. 잠시 후 다시 조회하고, 계속되면 LMS 탭을 새로고침하세요.",
  FORBIDDEN:
    "조회 권한이 없거나 세션이 만료되었습니다. LMS에서 로그인 상태를 확인하세요.",
  NETWORK: "LMS에 연결하지 못했습니다. 잠시 후 다시 시도하세요.",
  TIMEOUT: "조회 시간이 초과되었습니다. 다시 시도하세요.",
  INVALID_RESPONSE: "LMS 응답 형식이 예상과 다릅니다.",
  POLICY: "입력 또는 응답이 안전 정책에 맞지 않아 조회를 중단했습니다.",
  LIMIT: "페이지 수 제한 또는 반복 링크로 조회를 중단했습니다.",
  COURSE_NOT_FOUND:
    "일치하는 과목이 없습니다. 내 과목에서 과목명을 확인하세요.",
  COURSE_AMBIGUOUS:
    "여러 과목이 일치합니다. 전체 과목명을 입력하세요. 이름이 같은 과목은 현재 구분할 수 없습니다.",
  STALE_SELECTION:
    "선택이 만료되었거나 이미 사용한 항목입니다. 목록을 다시 조회하세요.",
  TAB_OPEN_FAILED: "새 탭을 열지 못했습니다. 목록을 다시 조회한 뒤 시도하세요.",
  BUSY: "이전 조회를 처리하고 있습니다. 잠시 후 다시 조회하세요.",
  DOWNLOAD_FAILED:
    "자료 다운로드를 시작하지 못했습니다. 목록을 다시 조회한 뒤 시도하세요.",
};
