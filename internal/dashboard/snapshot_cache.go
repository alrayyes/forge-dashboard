package dashboard

import (
	"context"
	"encoding/json"
	"log/slog"
	"slices"
	"strings"
	"time"
)

// WithSnapshotCache keeps the snapshot in c: the Aggregator starts from what
// the last run saved, marked stale until its first refresh succeeds, and saves
// every successful refresh. A cache that can't be read leaves it starting empty.
func WithSnapshotCache(c SnapshotCache) AggregatorOption {
	return func(a *Aggregator) { a.snapCache = c }
}

// cachedRepoRows is the JSON a snapshot_cache row holds: everything one
// refresh fetched for one repo.
type cachedRepoRows struct {
	Repo         Repo          `json:"repo"`
	PullRequests []PullRequest `json:"pullRequests"`
	Issues       []Issue       `json:"issues"`
	MainBranch   *MainBranch   `json:"mainBranch,omitempty"`
}

// restoreSnapshot loads what the last run saved and shows it as the current
// snapshot, every row stamped with when it was fetched so a client can tell it
// is old. Each forge is reported unreachable with that time as its StaleSince,
// the same mark a failed refresh puts on carried-over data, and goodAt is
// seeded from it so a first refresh that fails keeps these rows instead of
// dropping them. The first refresh that reaches a forge replaces its rows and
// clears the mark.
func (a *Aggregator) restoreSnapshot(ctx context.Context) {
	snap := newEmptySnapshot()
	for _, src := range a.sources {
		forge := src.Forge()
		rows, err := a.snapCache.LoadSnapshotRepos(ctx, forge, a.credentialFor(forge))
		if err != nil {
			slog.Warn("saved snapshot unreadable, starting empty", "forge", forge, "error", err)

			continue
		}

		newest, repos := addSavedRows(&snap, forge, rows)
		if repos == 0 {
			continue
		}
		snap.Forges = append(snap.Forges, ForgeHealth{
			Forge:      forge,
			Reachable:  false,
			ErrorKind:  ForgeErrorUnreachable,
			RepoCount:  repos,
			StaleSince: &newest,
		})
		a.lastGood[forge] = newest
		if newest.After(snap.GeneratedAt) {
			snap.GeneratedAt = newest
		}
	}
	if len(snap.Forges) == 0 {
		return
	}
	sortByRecency(snap.PullRequests, snap.Issues)
	a.snap = snap
	a.restored.Store(true)
}

// addSavedRows decodes one forge's saved rows into snap, stamping each repo
// and main branch with when it was fetched. It returns the newest fetch time
// and how many repos were readable; a row that can't be decoded is skipped.
func addSavedRows(snap *Snapshot, forge Forge, rows []CachedRepo) (newest time.Time, repos int) {
	for _, row := range rows {
		var payload cachedRepoRows
		if err := json.Unmarshal(row.Payload, &payload); err != nil {
			slog.Warn("saved snapshot row unreadable, skipping it", "forge", forge, "repo", row.Repo, "error", err)

			continue
		}
		fetched := row.FetchedAt.UTC()
		payload.Repo.StaleSince = &fetched
		if payload.MainBranch != nil {
			payload.MainBranch.StaleSince = &fetched
			snap.MainBranches = append(snap.MainBranches, *payload.MainBranch)
		}
		snap.Repos = append(snap.Repos, payload.Repo)
		snap.PullRequests = append(snap.PullRequests, payload.PullRequests...)
		snap.Issues = append(snap.Issues, payload.Issues...)
		repos++
		if fetched.After(newest) {
			newest = fetched
		}
	}

	return newest, repos
}

// saveSnapshot stores the rows of every forge that was read in full this
// refresh, one row per repo, replacing what was there so a repo no longer
// tracked drops out. A forge that failed keeps its earlier rows.
func (a *Aggregator) saveSnapshot(ctx context.Context, snap Snapshot) {
	if a.snapCache == nil {
		return
	}
	for _, h := range snap.Forges {
		if !h.Reachable || h.StaleSince != nil {
			continue
		}
		rows := snapshotRows(snap, h.Forge)
		if err := a.snapCache.SaveSnapshotRepos(ctx, h.Forge, a.credentialFor(h.Forge), rows); err != nil {
			slog.Warn("could not save the snapshot", "forge", h.Forge, "error", err)
		}
	}
}

// snapshotRows splits one forge's part of snap into a row per repo.
func snapshotRows(snap Snapshot, forge Forge) []CachedRepo {
	byRepo, fetchedAt := rowsByRepo(snap, forge)

	out := make([]CachedRepo, 0, len(byRepo))
	for repo, rows := range byRepo {
		payload, err := json.Marshal(rows)
		if err != nil {
			slog.Warn("could not encode a repo for the snapshot cache", "repo", repo, "error", err)

			continue
		}
		at, ok := fetchedAt[repo]
		if !ok {
			at = snap.GeneratedAt
		}
		out = append(out, CachedRepo{Repo: repo, FetchedAt: at, Payload: payload})
	}
	slices.SortFunc(out, func(a, b CachedRepo) int { return strings.Compare(a.Repo, b.Repo) })

	return out
}

// fetchTime is when r was really fetched: its own stale time when it was
// carried over, else the snapshot's.
func fetchTime(r Repo, generated time.Time) time.Time {
	if r.StaleSince != nil {
		return *r.StaleSince
	}

	return generated
}

// rowsByRepo collects one forge's rows per repo, and when each repo was
// really fetched: a repo carried over from an earlier refresh keeps its own
// stale time, any other is as new as the snapshot.
func rowsByRepo(snap Snapshot, forge Forge) (map[string]*cachedRepoRows, map[string]time.Time) {
	byRepo := map[string]*cachedRepoRows{}
	rowsFor := func(repo string) *cachedRepoRows {
		if r, ok := byRepo[repo]; ok {
			return r
		}
		r := &cachedRepoRows{}
		byRepo[repo] = r

		return r
	}
	fetchedAt := map[string]time.Time{}
	for _, r := range snap.Repos {
		if r.Forge == forge {
			rowsFor(r.FullName).Repo = r
			fetchedAt[r.FullName] = fetchTime(r, snap.GeneratedAt)
		}
	}
	for _, pr := range snap.PullRequests {
		if pr.Forge == forge {
			rows := rowsFor(pr.Repo)
			rows.PullRequests = append(rows.PullRequests, pr)
		}
	}
	for _, issue := range snap.Issues {
		if issue.Forge == forge {
			rows := rowsFor(issue.Repo)
			rows.Issues = append(rows.Issues, issue)
		}
	}
	for _, b := range snap.MainBranches {
		if b.Forge == forge {
			branch := b
			rowsFor(b.FullName).MainBranch = &branch
		}
	}

	return byRepo, fetchedAt
}
