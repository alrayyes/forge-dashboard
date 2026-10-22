package dashboard

import (
	"bytes"
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
// is old. Each forge is reported as Starting with that time as its StaleSince, not
// as an outage: nothing has asked the forge yet. goodAt is
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
			Starting:   true,
			RepoCount:  repos,
			StaleSince: &newest,
		})
		a.lastGood[forge] = newest
		a.rememberSaved(forge, rows)
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
// refresh, one row per repo. Only a repo whose rows differ from what is
// stored is written, and a repo no longer tracked is removed. A forge that
// failed keeps its earlier rows.
//
// A repo that did not change keeps the fetch time it was stored with, so after
// a restart its rows read as old as the last change, never newer than they are.
func (a *Aggregator) saveSnapshot(ctx context.Context, snap Snapshot) {
	if a.snapCache == nil {
		return
	}
	for _, h := range snap.Forges {
		if !h.Reachable || h.StaleSince != nil {
			continue
		}
		rows := snapshotRows(snap, h.Forge)
		changed, removed := a.savedDiff(h.Forge, rows)
		if len(changed) == 0 && len(removed) == 0 {
			continue
		}
		if err := a.snapCache.SaveSnapshotChanges(ctx, h.Forge, a.credentialFor(h.Forge), changed, removed); err != nil {
			slog.Warn("could not save the snapshot", "forge", h.Forge, "error", err)

			continue
		}
		a.rememberSaved(h.Forge, rows)
	}
}

// rememberSaved notes the payload stored for each of forge's repos, replacing
// what was noted before.
func (a *Aggregator) rememberSaved(forge Forge, rows []CachedRepo) {
	a.savedMu.Lock()
	defer a.savedMu.Unlock()

	if a.saved == nil {
		a.saved = make(map[Forge]map[string][]byte)
	}
	byRepo := make(map[string][]byte, len(rows))
	for _, r := range rows {
		byRepo[r.Repo] = r.Payload
	}
	a.saved[forge] = byRepo
}

// savedDiff splits rows into the ones that are new or differ from what is
// stored for forge, and the names of the stored repos that rows no longer has.
func (a *Aggregator) savedDiff(forge Forge, rows []CachedRepo) (changed []CachedRepo, removed []string) {
	a.savedMu.Lock()
	defer a.savedMu.Unlock()

	stored := a.saved[forge]
	now := make(map[string]struct{}, len(rows))
	for _, r := range rows {
		now[r.Repo] = struct{}{}
		if old, ok := stored[r.Repo]; !ok || !bytes.Equal(old, r.Payload) {
			changed = append(changed, r)
		}
	}
	for repo := range stored {
		if _, ok := now[repo]; !ok {
			removed = append(removed, repo)
		}
	}
	slices.Sort(removed)

	return changed, removed
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
