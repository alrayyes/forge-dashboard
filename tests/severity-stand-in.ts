// A stand-in for the server's `severity` on a mocked rate limit (#806).
//
// The real server grades each budget (internal/dashboard, RateLimit
// severity): `exceeded` when nothing is left, `low` when under 5% is, `warning` when
// under 20% is, `ok` otherwise. Mocked health in the specs states raw numbers, so this grades
// them the same way. The page reads the grade and holds no threshold, so
// this is a test double, not the page's logic. A spec that wants to say
// exactly what the server answered sets `severity` itself, as
// rate-limit-severity.spec.ts does. When the Go grading changes, change
// this too.

export type Severity = 'ok' | 'warning' | 'low' | 'exceeded';

export function severityOf(limit: number, remaining: number): Severity {
  if (remaining === 0) return 'exceeded';
  if (limit > 0 && remaining / limit < 0.05) return 'low';
  if (limit > 0 && remaining / limit < 0.2) return 'warning';
  return 'ok';
}

// A rate limit as the server would send it.
export function rateLimit(limit: number, remaining: number, resetsAt: string) {
  return { limit, remaining, resetsAt, severity: severityOf(limit, remaining) };
}
