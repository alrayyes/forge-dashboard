/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { createReferenceFollower } from './reference-follow';

// https://github.com/alrayyes/forge-dashboard/issues/4269
// Following a mention of an untracked repository must keep the user gesture:
// a tab opened after an await is blocked by Safari, so the tab opens first
// and is either closed (the dialog opens) or sent to the forge.
const ref = {
  forge: 'github',
  repo: 'o/r',
  number: 9,
  url: 'https://github.com/o/r/issues/9',
};

function setup(
  over: { probe?: () => Promise<unknown | null>; known?: boolean } = {},
) {
  const log: string[] = [];
  const tab = {
    location: { href: '' },
    close: () => log.push('tab.close'),
  };
  const follower = createReferenceFollower({
    probe: async () => {
      log.push('probe');
      return over.probe ? over.probe() : { state: 'closed' };
    },
    openTab: () => {
      log.push('openTab');
      return tab;
    },
    isKnown: () => over.known ?? false,
    remember: () => log.push('remember'),
    setBusy: (b) => log.push(`busy:${b}`),
  });
  return { follower, log, tab };
}

describe('createReferenceFollower', () => {
  test('opens the tab before it waits on the forge', async () => {
    const { follower, log } = setup();
    const done = follower(ref);
    expect(log.slice(0, 2)).toEqual(['busy:true', 'openTab']);
    await done;
  });

  test('closes the tab and opens the dialog when the forge shows the item', async () => {
    const { follower, log } = setup();
    expect(await follower(ref)).toBe('dialog');
    expect(log).toEqual([
      'busy:true',
      'openTab',
      'probe',
      'remember',
      'tab.close',
      'busy:false',
    ]);
  });

  test('sends the tab to the forge when it cannot be read, or on a timeout', async () => {
    const { follower, tab, log } = setup({ probe: async () => null });
    expect(await follower(ref)).toBe('forge');
    expect(tab.location.href).toBe(ref.url);
    expect(log).not.toContain('tab.close');
    expect(log.at(-1)).toBe('busy:false');
  });

  test('opens the dialog at once, with no tab or lookup, for an item already read', async () => {
    const { follower, log } = setup({ known: true });
    expect(await follower(ref)).toBe('dialog');
    expect(log).toEqual([]);
  });

  test('ignores a second click on the same item while the first is waiting', async () => {
    let release: (v: unknown) => void = () => {};
    let hold = true;
    const { follower, log } = setup({
      probe: () =>
        hold ? new Promise((r) => (release = r)) : Promise.resolve({}),
    });
    const first = follower(ref);
    expect(await follower(ref)).toBe('ignored');
    expect(log.filter((l) => l === 'openTab')).toHaveLength(1);
    hold = false;
    release({});
    expect(await first).toBe('dialog');
    // Once settled, the item can be followed again.
    expect(await follower(ref)).not.toBe('ignored');
  });

  test('a blocked tab still reports the forge outcome', async () => {
    const follower = createReferenceFollower({
      probe: async () => null,
      openTab: () => null,
      isKnown: () => false,
      remember: () => {},
      setBusy: () => {},
    });
    expect(await follower(ref)).toBe('forge');
  });
});
