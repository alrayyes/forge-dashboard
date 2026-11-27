/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

// A refs or mention pill is drawn like a closing one and says the difference
// in words (#5073): no stylesheet rule may restyle it by relation.

const sources = ['../style.css', './RelatedBand.svelte'];

describe('refs and mention pills', () => {
  for (const source of sources) {
    test(`${source} has no rule for a relation's own look`, () => {
      const css = readFileSync(new URL(source, import.meta.url), 'utf8');
      expect(css).not.toMatch(/\.(refs-pill|refs-issue|mention-pill)\b/);
    });
  }
});
