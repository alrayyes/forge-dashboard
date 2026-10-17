// The footer's own pages. Footer.svelte renders the same links in this order
// on every page and marks the one for the page you're on with
// aria-current="page" instead of dropping it (WCAG 2.2 3.2.3 Consistent
// Navigation).
// https://github.com/alrayyes/forge-dashboard/issues/1679
export type FooterPageKey = 'changelog' | 'disclaimer' | 'privacy';

export const FOOTER_PAGES: readonly {
  key: FooterPageKey;
  route: string;
  href: string;
}[] = [
  { key: 'changelog', route: '/changelog', href: '/changelog.html' },
  { key: 'disclaimer', route: '/disclaimer', href: '/disclaimer.html' },
  { key: 'privacy', route: '/privacy', href: '/privacy.html' },
];

// Tolerant of both the bare SvelteKit route and today's ".html"
// hard-navigation target.
export function currentFooterLink(path: string): FooterPageKey | null {
  const hit = FOOTER_PAGES.find((p) => path === p.route || path === p.href);
  return hit ? hit.key : null;
}
