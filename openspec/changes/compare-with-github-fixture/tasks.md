# Tasks

## 1. Harness

- [x] 1.1 Make the test compile again (`AllowedActions` takes the Renovate authors)
- [x] 1.2 Compare auto-merge armed and allowed, behind, stacks, closed and merged
- [x] 1.3 Repo-level tests: merge methods, linear history, auto-merge setting
- [x] 1.4 Fixture: stacked, armed auto-merge, merged; slow checks stay pending; behind pull requests the auto-update bot skips
- [x] 1.5 CONTRIBUTING: how to run it, and why it stays out of CI

## 2. Findings

- [x] 2.1 Owner bypass recorded as an expected difference
- [ ] 2.3 Behind in a repo without the up-to-date rule (https://github.com/alrayyes/forge-dashboard/issues/1183): decide the cost, fix, then drop `knownBehind`
- [ ] 2.2 Linear history on the base branch (https://github.com/alrayyes/forge-dashboard/issues/1173): fix in its own pull request, then drop the known entry from `TestGitHubState_MergeUsesAMethodTheRepoAllows`

## 3. Wrap up

- [ ] 3.1 Post the final agreement table on https://github.com/alrayyes/forge-dashboard/issues/950
