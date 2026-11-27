// The smallest single replacement that turns one text into another (common prefix and suffix
// kept). Applying an external text change this way lets the editor map the caret and selection
// through the change instead of resetting them. Never splits a UTF-16 surrogate pair.

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

export function minimalChange(from: string, to: string): { from: number; to: number; insert: string } {
  const max = Math.min(from.length, to.length);
  let start = 0;
  while (start < max && from.charCodeAt(start) === to.charCodeAt(start)) start++;
  if (start > 0 && isHigh(from.charCodeAt(start - 1))) start--; // keep a pair together
  let end = 0;
  while (end < max - start && from.charCodeAt(from.length - 1 - end) === to.charCodeAt(to.length - 1 - end)) end++;
  if (end > 0 && isLow(from.charCodeAt(from.length - end))) end--;
  return { from: start, to: from.length - end, insert: to.slice(start, to.length - end) };
}
