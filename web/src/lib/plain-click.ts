// Whether a click on a link should open its dialog where the reader is. Only
// an unmodified primary click does; a middle or modified click is left to the
// browser so the link still opens in a new tab.

export function isPlainClick(
  event: Pick<
    MouseEvent,
    | 'defaultPrevented'
    | 'button'
    | 'metaKey'
    | 'ctrlKey'
    | 'shiftKey'
    | 'altKey'
  >,
): boolean {
  return !(
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  );
}
