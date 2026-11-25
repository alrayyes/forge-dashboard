// Keeps a field's text clear of the buttons that sit inside it (#4863). The
// buttons' width follows the text size and the phone tap target, so a pixel
// constant in CSS drifts from it. This measures the buttons instead and sets
// --reserved on the wrapper; the field's padding-right reads it.

const GAP = 8; // px of air between the text and the first button

// Only the buttons present when the action runs are observed (the wrapper is
// observed too, but a button added later would not be). Every wrapper's
// buttons are static today; a conditional one needs re-observing here.
export function reserveButtons(node: HTMLElement) {
  const apply = () => {
    const box = node.getBoundingClientRect();
    if (box.width === 0) return; // hidden: measured again once shown
    let first = Infinity;
    for (const button of node.querySelectorAll('button')) {
      first = Math.min(first, button.getBoundingClientRect().left);
    }
    if (first === Infinity) return;
    node.style.setProperty(
      '--reserved',
      `${Math.ceil(box.right - first + GAP)}px`,
    );
  };
  const observer = new ResizeObserver(apply);
  observer.observe(node);
  for (const button of node.querySelectorAll('button'))
    observer.observe(button);
  apply();
  return { destroy: () => observer.disconnect() };
}
