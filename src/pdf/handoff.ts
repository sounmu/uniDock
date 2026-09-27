import { redactText } from "../security/redaction";

export const CHATGPT_URL = "https://chatgpt.com/";

export function questionPrompt(course: string): string {
  return `첨부한 ${redactText(course)} 수업 자료 PDF를 근거로 답해줘. 답변마다 파일명과 쪽을 표시해줘. 질문: `;
}

export async function copyPromptAndOpen(
  course: string,
  isCurrent: () => boolean = () => true,
): Promise<boolean> {
  let copied: boolean;
  try {
    await navigator.clipboard.writeText(questionPrompt(course));
    copied = true;
  } catch {
    // Clipboard permission denial must not prevent the explicit handoff.
    copied = false;
  }
  // Navigation can make this explicit handoff stale while the clipboard API is
  // waiting for the browser. Do not open a tab for an action the user left.
  if (!isCurrent()) return copied;
  await chrome.tabs.create({ url: CHATGPT_URL });
  return copied;
}
