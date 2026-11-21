/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import type { NavCounts, ServerNavCounts } from './nav-counts.svelte';
import { nextNavCounts } from './nav-counts-next';
import { navLinkShown } from './nav-link-shown';

// A page with nothing to show leaves the navigation (#1228), a page whose count
// is not known yet is not drawn either (#4276), and the page you are on keeps
// its own link (#1415).

describe('navLinkShown', () => {
  test('a count that is not known yet is not drawn', () => {
    expect(navLinkShown(null, false)).toBe(false);
  });

  test('a count of zero is not drawn', () => {
    expect(navLinkShown({ total: 0, failed: 0 }, false)).toBe(false);
  });

  test('a count above zero is drawn, whatever failed', () => {
    expect(navLinkShown({ total: 1, failed: 0 }, false)).toBe(true);
    expect(navLinkShown({ total: 4, failed: 4 }, false)).toBe(true);
  });

  test('the page you are on keeps its link at zero and while its count is unknown', () => {
    expect(navLinkShown({ total: 0, failed: 0 }, true)).toBe(true);
    expect(navLinkShown(null, true)).toBe(true);
  });
});

// The two rules together: what is drawn after a snapshot that says nothing
// about the counts (#4276, #4318).
describe('a snapshot with no navCounts', () => {
  const raw: ServerNavCounts = {
    pullRequests: { total: 3, failed: 0 },
    issues: { total: 0 },
    releases: { total: 0, failed: 0 },
    bots: { total: 2, failed: 0 },
  };
  const drawn = (counts: NavCounts | null) => ({
    pulls: navLinkShown(counts?.pullRequests ?? null, false),
    issues: navLinkShown(counts?.issues ?? null, false),
    releases: navLinkShown(counts?.releases ?? null, false),
    bots: navLinkShown(counts?.bots ?? null, false),
  });

  test('draws no count link when none was ever known', () => {
    const after = nextNavCounts(null, undefined, true, [], null);
    expect(drawn(after)).toEqual({
      pulls: false,
      issues: false,
      releases: false,
      bots: false,
    });
  });

  test('keeps the links already drawn, and still leaves out the ones at zero', () => {
    const known = nextNavCounts(null, raw, true, [], null);
    const after = nextNavCounts(known, undefined, true, [], null);
    expect(drawn(after)).toEqual({
      pulls: true,
      issues: false,
      releases: false,
      bots: true,
    });
  });
});
