// Accepts 01712345678, +8801712345678, 8801712345678 and spaced/hyphenated
// variants. Operator prefixes 013-019 only: 012 is not a public mobile range.
const BANGLADESH_MOBILE = /^(?:\+?880|0)(1[3-9]\d{8})$/;

/** Returns the canonical +8801XXXXXXXXX form, or null when the number is invalid. */
export function normalizeMobile(input: string): string | null {
  const cleaned = input.replace(/[\s\-()]/g, '');
  const match = BANGLADESH_MOBILE.exec(cleaned);
  if (!match) return null;
  return `+880${match[1]}`;
}
