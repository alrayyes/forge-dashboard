# 1. Business rules live behind the API, not in the page

Status: accepted (2026-10-05)

## Context

The page started as the only client, and it decided things for itself: which
actions a pull request offers, what the Ready and Needs review filters mean,
how a rate limit is graded, which issues count as work. Each was reasonable
where it sat. Then there was a second client: the MCP endpoint for agents,
client libraries generated from the OpenAPI spec, and anything someone builds
on the API. Each of them would have to copy the page's rules and keep the
copies in step, and the rules were also unenforced, because a check in the
browser can be skipped. An audit of the front end
([#746](https://github.com/alrayyes/forge-dashboard/issues/746)) found the
rules scattered through a single page of several thousand lines.

## Decision

A rule that a second client would need the same answer for lives in the
backend, in `internal/dashboard`. The API sends the answer as a field
(`allowedActions`, `readyToMerge`, `housekeeping`, `severity`) and the write
endpoints enforce the same rule, so a client that skips the page still can't
merge a draft. The page formats, lays out and keeps view state, and holds no
copy of a rule. Validation is decided by the server, and a client may repeat it
from the OpenAPI schema for quick feedback.

A rule the API doesn't expose yet is a gap in the API: the spec changes first,
then a failing backend test, then the backend, then the page switches and its
copy is deleted, one rule per pull request.

## Consequences

- Every client gets the same answer, and the server refuses what the page
  would have hidden.
- The API carries more fields, and the spec changes whenever a rule does.
  Client libraries regenerate more often.
- The page can't change a rule alone. A change that used to be one component is
  now a spec edit, a Go change and a page change.
- The browser tests mock the API, so they carry small stand-ins for the
  server's answers (`tests/allowed-actions-stand-in.ts`). Those follow the Go
  rules by hand and can drift. The contract tests in `internal/api` check the
  real responses against the spec, which is what keeps the two honest.
- Live state the server can't know, such as a forge that is unreachable right
  now or an action already in flight, stays in the page.

## Sources

- Martin Fowler on
  [presentation and domain layering](https://martinfowler.com/bliki/PresentationDomainDataLayering.html)
- The OWASP
  [Input Validation Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html)
  puts validation on the server
