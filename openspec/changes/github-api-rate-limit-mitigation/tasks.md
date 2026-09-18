# Tasks

## 1. Poll interval

- [ ] 1.1 Raise `defaultRefreshInterval` (`cmd/forge-dashboard/main.go`) from 5 minutes to 15-30 minutes, and verify `REFRESH_INTERVAL` still overrides it via the existing test coverage
- [ ] 1.2 Update README/docs describing the default refresh cadence, in the same commit

## 2. Issues `since` filtering

- [ ] 2.1 Track the last successful poll time per user in the aggregator's existing in-memory state
- [ ] 2.2 Pass `filterBy: { since: <last poll time> }` on the issues connection in `reposQueryTemplate` for a repeat poll (never on the very first poll for a user, which has no prior time to filter from), and verify via a test against a fake GraphQL response that the filter argument is present on a second call and absent on the first
- [ ] 2.3 Verify pull requests are deliberately NOT given an equivalent filter (no such filter exists on that connection) — a comment noting why, not a TODO

## 3. ETag caching on REST calls

- [ ] 3.1 Add an in-memory ETag cache keyed by request URL for this client's own REST calls (`checkWebhooks`'s hook listing, the anonymous/no-token REST fallback path)
- [ ] 3.2 Send `If-None-Match` on a repeat call when a cached ETag exists, and treat a 304 response as "reuse the cached body," verified via a test asserting a 304 doesn't error and returns the previously cached data

## 4. Backoff on low remaining budget

- [ ] 4.1 After each refresh, check the just-observed `RateLimit.Remaining`/`Limit`/`ResetsAt`; when remaining is critically low (e.g. under 5%), delay the next scheduled poll rather than firing at the normal interval
- [ ] 4.2 Cap the delay so it never meaningfully exceeds `ResetsAt`, verified via a test simulating a near-zero remaining budget and asserting the next poll is scheduled at or before the reset time plus a small buffer

## 5. Verification

- [ ] 5.1 Run the full test suite and confirm no existing test assumes the old 5-minute default or an unconditional issues query with no `since` argument
