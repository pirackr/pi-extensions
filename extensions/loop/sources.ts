/**
 * Pure helpers for research_checkpoint's honest source counting.
 * Kept free of fs/pi imports so they are unit-testable in isolation.
 */

/** Extract the number of unique source URLs from notes.md-style text. */
export function countUniqueSourceUrls(text: string): number {
 const urls = new Set<string>();
 for (const match of text.matchAll(/https?:\/\/[^\s)>\]}"']+/g)) {
  urls.add(match[0].replace(/[.,;:!?]+$/, ""));
 }
 return urls.size;
}

/**
 * Effective source count for the floor check: min(reported, counted).
 * `counted` is null when notes.md is absent/unreadable — fall back to
 * reported. Returns a hint when the model over-reports.
 */
export function effectiveSourceCount(
 reported: number,
 counted: number | null,
): { sources: number; hint: string } {
 if (counted == null || counted >= reported) {
  return { sources: reported, hint: "" };
 }
 return {
  sources: counted,
  hint: ` ⚠ reported ${reported} sources but notes.md lists ${counted} unique URLs — pass the real count`,
 };
}
