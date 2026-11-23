/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { offerForges } from './filters';

// The Insights Forge pills go whole when one forge is in scope, unless a
// forge is picked, so the pick can be seen and cleared (#4273, #4615).
// https://github.com/alrayyes/forge-dashboard/issues/4273

describe('offerForges', () => {
  test('hides the group for one forge when nothing is picked', () => {
    expect(offerForges(new Set(['github']), '').hidden).toBe(true);
  });

  test('keeps the group and the picked forge for one forge when one is picked', () => {
    const offer = offerForges(new Set(['github']), 'forgejo');
    expect(offer.hidden).toBe(false);
    expect([...offer.forges].sort()).toEqual(['forgejo', 'github']);
  });

  test('shows the group for two forges', () => {
    const offer = offerForges(new Set(['github', 'forgejo']), '');
    expect(offer.hidden).toBe(false);
    expect([...offer.forges].sort()).toEqual(['forgejo', 'github']);
  });
});
