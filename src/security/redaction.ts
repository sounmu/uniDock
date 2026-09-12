const hidden = "[REDACTED]";
// Defense in depth for display text; logs never accept arbitrary text or objects.
export function redactText(text: string, privateValues: string[] = []): string {
  let safe = text;
  for (const value of privateValues)
    if (value) safe = safe.split(value).join(hidden);
  return (
    safe
      .replace(/https?:\/\/[^\s<>"']+/gi, hidden)
      .replace(/[\w.%+-]+@[\w.-]+\.[a-z]{2,}/gi, hidden)
      .replace(
        /(?:authorization|bearer|cookie|token|password|pwd|session|saml\w*|oauth\w*|course[_ -]?id|KU_LMS_ID)\s*[:=]?\s*[^\n]+/gi,
        hidden,
      )
      .replace(/\b\d{8,}\b/g, hidden)
      // Control characters are intentionally removed from display text.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]/g, " ")
  );
}
