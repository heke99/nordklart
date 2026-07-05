/**
 * Escape user-influenced values before interpolating them into HTML email
 * templates. Names (customers, companies, inviters) are user-controlled and
 * must never reach the HTML body unescaped.
 */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}
