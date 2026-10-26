// A rate limit as the server sends it: the numbers, and no grade. The page
// grades them itself (web/src/lib/rate-limit.ts, #2929).

export function rateLimit(limit: number, remaining: number, resetsAt: string) {
  return { limit, remaining, resetsAt };
}
