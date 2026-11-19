// Whether the open dialog's footer is already what the board's copy of its
// pull request would draw (#4327). The buttons are built from the item and
// close over it, so same markup is not enough when the item itself changed.
// Every snapshot hands the board fresh objects, so "the same item" is the
// same content, not the same object: otherwise a poll that changed some other
// row would rebuild the footer under the pointer.
type Chrome<T> = { sig: string; item: T | undefined };

export function chromeIsCurrent<T extends object>(
  shown: Chrome<T>,
  next: Chrome<T>,
): boolean {
  if (shown.sig !== next.sig) return false;
  if (shown.item === next.item) return true;

  return JSON.stringify(shown.item) === JSON.stringify(next.item);
}
