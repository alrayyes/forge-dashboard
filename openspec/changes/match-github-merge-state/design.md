# Design

The rule that blocks on any pending check (#385) and the mapping of UNSTABLE
to blocked both predate required-check awareness. Both should defer to the
forge's own mergeability verdict, then add the dashboard's extra blocks
(draft, empty, stacked) on top.

Decision: trust GitHub's `mergeStateStatus` for check gating instead of
re-deriving "required" from the rollup. UNSTABLE means non-required checks
are failing or pending; BLOCKED means a requirement isn't met. This keeps the
dashboard from drifting when branch protection changes.

Tracked by the fixture test in `integration/github_state_test.go`, which
lists each known gap by ticket and fails once a gap closes.
