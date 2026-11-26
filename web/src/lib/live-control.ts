import { hasTimestamp } from './first-refresh.js';
import type { ForgeCause } from './forge-starting.js';

// The one live control in a list card header (#3699): status, the time of the
// snapshot on screen, Pause or Resume, and refresh. The time is the
// snapshot's own generatedAt, so a refresh that fails leaves it where it was.

export function updatedText(iso: string | null, nowMs: number): string {
  if (!hasTimestamp(iso)) return '';
  const seconds = Math.max(
    0,
    Math.round((nowMs - Date.parse(iso ?? '')) / 1000),
  );
  if (seconds < 60) return `updated ${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `updated ${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `updated ${hours}h ago`;
  return `updated ${Math.round(hours / 24)}d ago`;
}

// The forges' health as far as this control reads it.
export type CausedForges = readonly { cause?: ForgeCause }[];

// "Live" is only true while no forge shows rows held from an earlier read.
// Paused comes first: it is what the user asked for. A start-up outranks a
// slow forge.
export function liveStatus(paused: boolean, forges: CausedForges = []): string {
  if (paused) return 'Paused';
  if (forges.some((f) => f.cause === 'starting')) return 'Starting up';
  if (forges.some((f) => f.cause === 'slow')) return 'Slow to answer';
  return 'Live';
}

// Whether the status dot says the rows are held.
export function isHeld(paused: boolean, forges: CausedForges): boolean {
  return !paused && forges.some((f) => f.cause !== undefined);
}

// The name holds the visible word (WCAG 2.5.3) and says what it acts on.
export function pauseLabel(paused: boolean): { text: string; name: string } {
  return paused
    ? { text: 'Resume', name: 'Resume live updates' }
    : { text: 'Pause', name: 'Pause live updates' };
}
