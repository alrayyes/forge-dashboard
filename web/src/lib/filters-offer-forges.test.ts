/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { offerForges } from './filters';

// The Insights Forge buttons go whole when one forge is in scope, unless a
// forge is picked, so the pick can be seen and cleared (#4273).
// https://github.com/alrayyes/forge-dashboard/issues/4273

function bar(values: string[]) {
  const group = { hidden: true };
  const labels = values.map(() => ({ hidden: false }));
  const inputs = values.map((value, i) => ({
    value,
    closest: (selector: string) =>
      selector === 'fieldset' ? group : labels[i],
  }));
  const scope = {
    querySelectorAll: () => inputs,
  } as unknown as ParentNode;
  return { scope, group, labels };
}

describe('offerForges', () => {
  test('hides the group for one forge when nothing is picked', () => {
    const { scope, group } = bar(['', 'github', 'forgejo']);
    offerForges(scope, new Set(['github']), '');
    expect(group.hidden).toBe(true);
  });

  test('keeps the group for one forge when a forge is picked', () => {
    const { scope, group, labels } = bar(['', 'github', 'forgejo']);
    offerForges(scope, new Set(['github']), 'forgejo');
    expect(group.hidden).toBe(false);
    expect(labels[2]?.hidden).toBe(false);
  });

  test('shows the group for two forges', () => {
    const { scope, group } = bar(['', 'github', 'forgejo']);
    offerForges(scope, new Set(['github', 'forgejo']), '');
    expect(group.hidden).toBe(false);
  });
});
