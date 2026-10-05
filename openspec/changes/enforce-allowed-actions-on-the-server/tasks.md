## 1. Merge

- [x] 1.1 Spec the 409 on `POST /api/pull-requests/merge`
- [x] 1.2 Failing Go tests: a blocked Merge is refused without asking the forge; an allowed one still merges
- [x] 1.3 Refuse in `handlePullRequestMerge` through `refuseIfNotAllowed`

## 2. The other actions (separate pull requests)

- [x] 2.1 Update branch
- [ ] 2.2 Enable auto-merge
- [ ] 2.3 Dependabot and Renovate actions, including that the pull request belongs to that bot
