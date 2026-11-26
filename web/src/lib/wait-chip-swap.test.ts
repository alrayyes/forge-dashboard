/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import {
  swapDetail,
  swapLabel,
  swapName,
  swapPhaseOf,
  swapSourceOf,
  tapOutcome,
} from './wait-chip-swap';

describe('tapOutcome', () => {
  test('a mouse click on a previewed chip runs Update branch', () => {
    expect(tapOutcome({ revealed: true, detail: 1, locked: false })).toBe(
      'run',
    );
  });

  test('a first touch tap only reveals Update branch', () => {
    expect(tapOutcome({ revealed: false, detail: 1, locked: false })).toBe(
      'reveal',
    );
  });

  test('Enter, Space and a screen reader click (detail 0) run it at once', () => {
    expect(tapOutcome({ revealed: false, detail: 0, locked: false })).toBe(
      'run',
    );
  });

  test('a locked button never runs, and says why instead', () => {
    expect(tapOutcome({ revealed: true, detail: 0, locked: true })).toBe(
      'explain',
    );
    expect(tapOutcome({ revealed: false, detail: 1, locked: true })).toBe(
      'explain',
    );
  });
});

describe('swapLabel', () => {
  test('shows the wait until the swap is revealed', () => {
    expect(swapLabel({ revealed: false, inFlight: false })).toBe(
      'Waiting for CI',
    );
    expect(swapLabel({ revealed: true, inFlight: false })).toBe(
      'Update branch',
    );
  });

  test('says Updating branch while in flight, revealed or not', () => {
    expect(swapLabel({ revealed: false, inFlight: true })).toBe(
      'Updating branch…',
    );
    expect(swapLabel({ revealed: true, inFlight: true })).toBe(
      'Updating branch…',
    );
  });
});

describe('swapDetail', () => {
  const idleDetail = 'Auto-merge armed';

  test('keeps the first line of the chip until the swap is revealed', () => {
    expect(
      swapDetail({ phase: 'idle', revealed: false, idleDetail, reason: '' }),
    ).toBe(idleDetail);
  });

  test('says what happens next once revealed', () => {
    expect(
      swapDetail({ phase: 'idle', revealed: true, idleDetail, reason: '' }),
    ).toBe('Then auto-merge goes on');
  });

  test('a locked button gives its reason when revealed', () => {
    expect(
      swapDetail({
        phase: 'locked',
        revealed: true,
        idleDetail,
        reason: 'Approve the runs first',
      }),
    ).toBe('Approve the runs first');
    expect(
      swapDetail({ phase: 'locked', revealed: false, idleDetail, reason: 'x' }),
    ).toBe(idleDetail);
  });

  test('in flight says auto-merge follows, revealed or not', () => {
    for (const revealed of [true, false])
      expect(
        swapDetail({ phase: 'inflight', revealed, idleDetail, reason: '' }),
      ).toBe('Auto-merge follows when it lands');
  });
});

describe('swapName', () => {
  test('one name for every state but in flight', () => {
    expect(swapName('idle')).toBe('Waiting for CI, update branch');
    expect(swapName('locked')).toBe('Waiting for CI, update branch');
    expect(swapName('inflight')).toBe('Waiting for CI, updating branch');
  });
});

// Minimal stand-ins for the two cells updateBranchActionCell returns: the bare
// button on the idle path, and the span around a locked or retry button.
function fakeButton(text: string, attrs: Record<string, string> = {}) {
  return {
    tagName: 'BUTTON',
    textContent: text,
    getAttribute: (name: string) => attrs[name] ?? null,
    querySelector: () => null,
    click: () => {},
  };
}
function fakeWrap(button: ReturnType<typeof fakeButton>) {
  return {
    tagName: 'SPAN',
    textContent: button.textContent,
    getAttribute: () => null,
    querySelector: (selector: string) =>
      selector === 'button' ? button : null,
    click: () => {},
  };
}

describe('swapSourceOf', () => {
  test('a bare idle button is its own source', () => {
    const button = fakeButton('Update branch');
    expect(swapSourceOf(button)).toBe(button);
  });

  test('a locked cell is read through its wrapper', () => {
    const button = fakeButton('Update branch', { 'aria-disabled': 'true' });
    expect(swapSourceOf(fakeWrap(button))).toBe(button);
  });

  test('no cell, no swap', () => {
    expect(swapSourceOf(null)).toBeUndefined();
  });

  test('a retryable lock is a Retry button and keeps the row its plain button', () => {
    expect(swapSourceOf(fakeWrap(fakeButton('Retry')))).toBeUndefined();
  });
});

describe('swapPhaseOf', () => {
  test('idle until the button is disabled or run', () => {
    expect(swapPhaseOf({ disabled: false, ran: false })).toBe('idle');
  });

  test('locked when the real button is disabled and was not run here', () => {
    expect(swapPhaseOf({ disabled: true, ran: false })).toBe('locked');
  });

  test('in flight once the swap ran it and the button is pending', () => {
    expect(swapPhaseOf({ disabled: true, ran: true })).toBe('inflight');
  });

  test('idle again if it ran but the button is no longer pending', () => {
    expect(swapPhaseOf({ disabled: false, ran: true })).toBe('idle');
  });
});
