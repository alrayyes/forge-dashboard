// What makes two label names the same label. A leaf module: the Label filter
// and the label colours both need it, and neither may import the other.

// A label's name as the filter keys it: trimmed and lower-cased, with control
// characters (a line break, a tab) turned into a space, so a name can never
// split into two picks. The page matches items on this too, so such a label
// still matches itself.
export function labelKey(name: string): string {
  return name
    .replace(/\p{Cc}+/gu, ' ')
    .trim()
    .toLowerCase();
}
