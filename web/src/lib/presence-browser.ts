// The browser side of presence.ts: the real document, timers and fetch.
// Sources for the choices: MDN's Page Visibility API (visibilitychange tells a
// hidden tab from a merely unfocused one) and Chrome's Page Lifecycle guide
// (the hidden transition is the last reliable event, so it is where the "gone"
// report is sent, with keepalive so it survives the page going away).
import { createPresence, type PresenceTimings } from './presence';

// Sent on the page's own timed reads, so a hidden or unattended tab that keeps
// polling is not taken for someone using the dashboard.
export const BACKGROUND_READ_HEADER = { 'X-Background-Read': 'true' };

function newViewerId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

// Starts reporting this tab's visibility; returns the function that stops it.
export function startPresence(): () => void {
  const viewerId = newViewerId();
  const presence = createPresence({
    now: () => Date.now(),
    isVisible: () => document.visibilityState === 'visible',
    setTimer: (fn, ms) => window.setTimeout(fn, ms),
    clearTimer: (handle) => window.clearTimeout(handle as number),
    send: async (visible): Promise<PresenceTimings | null> => {
      try {
        const res = await fetch('/api/dashboard/presence', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ viewerId, visible }),
          keepalive: true,
        });
        return res.ok ? ((await res.json()) as PresenceTimings) : null;
      } catch {
        return null;
      }
    },
  });

  const onVisibility = () => presence.visibilityChanged();
  const onInput = () => presence.input();
  const inputEvents = [
    'pointerdown',
    'pointermove',
    'keydown',
    'wheel',
    'touchstart',
  ];
  document.addEventListener('visibilitychange', onVisibility);
  // A page restored from the back/forward cache never ran start() again.
  window.addEventListener('pageshow', onVisibility);
  for (const name of inputEvents) {
    window.addEventListener(name, onInput, { passive: true });
  }
  window.addEventListener('scroll', onInput, { passive: true });
  presence.start();

  return () => {
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pageshow', onVisibility);
    for (const name of inputEvents) window.removeEventListener(name, onInput);
    window.removeEventListener('scroll', onInput);
    presence.stop();
  };
}
