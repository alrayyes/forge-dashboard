// The clear button and Escape for a text filter box (#4077, #4144). It empties
// the box and fires the box's own input event, so the page's handler resets
// that one filter and nothing else.

type Box = Pick<HTMLInputElement, 'value' | 'focus' | 'dispatchEvent'>;

/** Empties the box. False, and no event, when it was already empty. */
export function clearBox(box: Box): boolean {
  if (box.value === '') return false;
  box.value = '';
  box.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}

/**
 * Wires Escape in the box and a click on the button to clearBox. Escape is
 * consumed only when it cleared something, so an empty box leaves it to the
 * page. Focus stays in, or returns to, the box. Returns the unwire function.
 */
export function wireClearBox(
  box: Box & Pick<HTMLInputElement, 'addEventListener' | 'removeEventListener'>,
  button: Pick<HTMLElement, 'addEventListener' | 'removeEventListener'>,
): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && clearBox(box)) e.preventDefault();
  };
  // A press must not pull focus off the box (Firefox moves it otherwise).
  const onDown = (e: Event) => e.preventDefault();
  const onClick = () => {
    clearBox(box);
    box.focus();
  };
  box.addEventListener('keydown', onKey);
  button.addEventListener('mousedown', onDown);
  button.addEventListener('click', onClick);
  return () => {
    box.removeEventListener('keydown', onKey);
    button.removeEventListener('mousedown', onDown);
    button.removeEventListener('click', onClick);
  };
}
