// A number when the text reads as one, otherwise the text itself, so the
// server refuses it instead of an unparsable value turning into 0 and
// silently clearing the setting. Empty means "not set" and sends 0.
export function installationIdPayload(raw: string): number | string {
  const trimmed = raw.trim();
  if (!trimmed) return 0;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : trimmed;
}
