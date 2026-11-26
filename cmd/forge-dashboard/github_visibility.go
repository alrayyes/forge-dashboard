package main

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/oauth"
)

// visibleReposTTL is how long the repos a linked user can read through one
// installation are remembered. A poll can run every few seconds, and the list
// comes from the user's own rate limit, so it is asked about once a minute.
const visibleReposTTL = time.Minute

// visibleRepos remembers, per installation, the repos the linked GitHub
// account can read (#4576). Only a successful answer is kept, and a changed
// or removed account drops everything it knew.
type visibleRepos struct {
	user *oauth.GitHub
	now  func() time.Time

	mu      sync.Mutex
	entries map[int64]visibleEntry
}

type visibleEntry struct {
	repos map[string]struct{}
	at    time.Time
}

func newVisibleRepos(user *oauth.GitHub) *visibleRepos {
	return &visibleRepos{user: user, now: time.Now, entries: map[int64]visibleEntry{}}
}

// forInstallation reads the repos for installation id, for
// github.Client.SetVisibleRepos. With no account linked it answers nil, which
// means no filtering.
func (v *visibleRepos) forInstallation(id int64) func(context.Context) (map[string]struct{}, error) {
	return func(ctx context.Context) (map[string]struct{}, error) {
		v.mu.Lock()
		cached, ok := v.entries[id]
		v.mu.Unlock()

		if ok && v.now().Sub(cached.at) < visibleReposTTL {
			return cached.repos, nil
		}

		repos, err := v.user.InstallationRepos(ctx, id)
		if errors.Is(err, oauth.ErrNotConnected) {
			v.mu.Lock()
			delete(v.entries, id)
			v.mu.Unlock()

			return nil, nil
		}

		if err != nil {
			return nil, err
		}

		v.mu.Lock()
		v.entries[id] = visibleEntry{repos: repos, at: v.now()}
		v.mu.Unlock()

		return repos, nil
	}
}
