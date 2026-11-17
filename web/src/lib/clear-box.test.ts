/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { clearBox, wireClearBox } from './clear-box';

// The clear button and Escape for a text box (#4077, #4144). The helper
// empties one box and fires its own input event, so the page's handler resets
// that filter and nothing else.
type Handler = (e: { key?: string; preventDefault: () => void }) => void;

function fakeBox(value: string) {
  const fired: string[] = [];
  const handlers: Record<string, Handler> = {};
  let focused = 0;
  return {
    value,
    fired,
    handlers,
    get focused() {
      return focused;
    },
    focus() {
      focused++;
    },
    dispatchEvent(e: Event) {
      fired.push(e.type);
      return true;
    },
    addEventListener(type: string, h: Handler) {
      handlers[type] = h;
    },
    removeEventListener(type: string) {
      delete handlers[type];
    },
  };
}

describe('clearBox', () => {
  test('empties a box with text and fires one input event', () => {
    const box = fakeBox('abc');
    expect(clearBox(box)).toBe(true);
    expect(box.value).toBe('');
    expect(box.fired).toEqual(['input']);
  });

  test('does nothing, and says so, on an empty box', () => {
    const box = fakeBox('');
    expect(clearBox(box)).toBe(false);
    expect(box.fired).toEqual([]);
  });
});

describe('wireClearBox', () => {
  test('Escape clears and is consumed only when there was text', () => {
    const box = fakeBox('abc');
    const button = fakeBox('');
    wireClearBox(box, button);
    let prevented = 0;
    const press = (key: string) =>
      box.handlers.keydown({ key, preventDefault: () => prevented++ });
    press('a');
    expect(box.value).toBe('abc');
    press('Escape');
    expect(box.value).toBe('');
    expect(prevented).toBe(1);
    press('Escape');
    expect(prevented).toBe(1);
  });

  test('a click clears and returns focus to the box', () => {
    const box = fakeBox('abc');
    const button = fakeBox('');
    wireClearBox(box, button);
    button.handlers.click({ preventDefault() {} });
    expect(box.value).toBe('');
    expect(box.focused).toBe(1);
  });

  test('a press keeps focus where it was', () => {
    const box = fakeBox('abc');
    const button = fakeBox('');
    wireClearBox(box, button);
    let prevented = false;
    button.handlers.mousedown({
      preventDefault: () => {
        prevented = true;
      },
    });
    expect(prevented).toBe(true);
  });

  test('the returned function unwires it', () => {
    const box = fakeBox('abc');
    const button = fakeBox('');
    const off = wireClearBox(box, button);
    off();
    expect(box.handlers.keydown).toBeUndefined();
    expect(button.handlers.click).toBeUndefined();
  });
});
