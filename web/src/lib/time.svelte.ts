// One place that turns an instant into text, so every page names the same
// zone (#996). Some browsers (Firefox with privacy.resistFingerprinting, Tor
// Browser) report UTC to every page, so reading the browser's zone alone
// can't be trusted: the account can save a zone of its own, and that wins.
// With none saved, the browser's zone is used. A short zone label always
// goes with a time, so a reader can see which zone it is in.
//
// The label comes from Intl and follows the viewer's locale: en-GB writes
// Europe/Amsterdam as "CEST", en-US as "GMT+2". That is Intl, not a bug here.
// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/DateTimeFormat/DateTimeFormat#timezonename

// The saved zone: an IANA name, or "" for the browser's own. Reactive, so a
// Svelte template that calls a formatter below redraws when it changes.
export const timezone = $state({ setting: '' });

let loading: Promise<void> | undefined;
const listeners = new Set<() => void>();

// For code outside Svelte's reactivity (the dashboard builds its DOM by
// hand). Returns the way to stop listening.
export function onTimezoneChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Saves nothing: the Settings control PUTs the value, then tells every
// page here.
export function setTimezoneSetting(zone: string): void {
  if (timezone.setting === zone) return;
  timezone.setting = zone;
  for (const listener of listeners) listener();
}

// Reads the saved zone once per page load. A failed or empty answer leaves
// the browser's zone in charge.
export function loadTimezone(): Promise<void> {
  loading ??= (async () => {
    try {
      const res = await fetch('/api/settings/timezone', {
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) return;
      const data: { timezone?: string } = await res.json();
      setTimezoneSetting(data.timezone ?? '');
    } catch {
      /* offline, signed out, etc.: the browser's zone stands */
    }
  })();
  return loading;
}

export function browserZone(): string {
  return new Intl.DateTimeFormat().resolvedOptions().timeZone;
}

// Whether the engine accepts the name, so a saved zone it can't format
// falls back instead of throwing on every render.
function usable(zone: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export function effectiveZone(): string {
  return timezone.setting && usable(timezone.setting)
    ? timezone.setting
    : browserZone();
}

// A calendar day in the zone, to tell whether two instants share one.
// en-CA writes year-month-day, which compares as a string.
function dayKey(date: Date, zone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function parse(iso: string): Date | null {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

// "14:00 CEST", with the date in front ("6 Oct, 14:00 CEST") when the
// instant is not on today's date in the zone, and the year too when it is
// not this year. The "resets at" shape. `zone` and `now` are for the
// caller that already knows them.
export function formatTime(
  iso: string,
  zone: string = effectiveZone(),
  now: number = Date.now(),
): string {
  const date = parse(iso);
  if (!date) return iso;
  const sameDay = dayKey(date, zone) === dayKey(new Date(now), zone);
  const sameYear =
    dayKey(date, zone).slice(0, 4) === dayKey(new Date(now), zone).slice(0, 4);
  return new Intl.DateTimeFormat(undefined, {
    timeZone: zone,
    ...(sameDay
      ? {}
      : {
          day: 'numeric',
          month: 'short',
          ...(sameYear ? {} : { year: 'numeric' }),
        }),
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(date);
}

// The calendar date in the zone, with no time and so no label.
export function formatDate(
  iso: string,
  zone: string = effectiveZone(),
): string {
  const date = parse(iso);
  if (!date) return iso;
  return new Intl.DateTimeFormat(undefined, { timeZone: zone }).format(date);
}

// Date, time and zone label, whatever day it is: for a log line or a
// preview, where the day matters every time.
export function formatDateTime(
  iso: string,
  zone: string = effectiveZone(),
): string {
  const date = parse(iso);
  if (!date) return iso;
  return new Intl.DateTimeFormat(undefined, {
    timeZone: zone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(date);
}

// Every IANA zone the engine knows, with UTC kept in (Chrome's list leaves it
// out), and `include` so a saved name the list lacks still shows. Engines
// without Intl.supportedValuesOf get just those two.
export function zoneNames(include = ''): string[] {
  let names: string[] = [];
  try {
    names = Intl.supportedValuesOf('timeZone');
  } catch {
    /* an engine without supportedValuesOf */
  }
  return [...new Set([...names, 'UTC', ...(include ? [include] : [])])].sort();
}
