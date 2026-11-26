package main

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/oauth"
)

// visibleReposTTL is how long the repos a linked user can read through one
// installation are remembered. A poll can run every few seconds, and the list
// comes from the user's own rate limit, so it is asked about once a minute.
const visibleReposTTL = time.Minute

// visibleReposFailureTTL is how long a failed read is remembered, so a broken
// endpoint isn't asked again on every poll.
const visibleReposFailureTTL = 15 * time.Second

// visibleRepos remembers, per installation, the repos the linked GitHub
// account can read (#4576). An answer belongs to the account that asked: a
// different login, or none, never reads another's list. A failure is kept
// briefly.
type visibleRepos struct {
	user *oauth.GitHub
	now  func() time.Time

	mu      sync.Mutex
	entries map[int64]visibleEntry
}

type visibleEntry struct {
	login string
	repos map[string]struct{}
	err   error
	at    time.Time
}

func (e visibleEntry) fresh(now time.Time, login string) bool {
	ttl := visibleReposTTL
	if e.err != nil {
		ttl = visibleReposFailureTTL
	}

	return e.login == login && now.Sub(e.at) < ttl
}

func newVisibleRepos(user *oauth.GitHub) *visibleRepos {
	return &visibleRepos{user: user, now: time.Now, entries: map[int64]visibleEntry{}}
}

// forInstallation reads the repos for installation id, for
// github.Client.SetVisibleRepos. With no account linked it answers nil, which
// means no filtering.
func (v *visibleRepos) forInstallation(id int64) func(context.Context) (map[string]struct{}, error) {
	return func(ctx context.Context) (map[string]struct{}, error) {
		login := v.user.Login(ctx)

		v.mu.Lock()
		cached, ok := v.entries[id]
		v.mu.Unlock()

		if ok && login != "" && cached.fresh(v.now(), login) {
			return cached.repos, cached.err
		}

		repos, err := v.user.InstallationRepos(ctx, id)
		if errors.Is(err, oauth.ErrNotConnected) {
			v.mu.Lock()
			delete(v.entries, id)
			v.mu.Unlock()

			return nil, nil
		}

		if err != nil {
			err = fmt.Errorf("list the repos the linked user can read: %w", err)
			v.mu.Lock()
			v.entries[id] = visibleEntry{login: login, err: err, at: v.now()}
			v.mu.Unlock()

			return nil, err
		}

		v.mu.Lock()
		v.entries[id] = visibleEntry{login: login, repos: repos, at: v.now()}
		v.mu.Unlock()

		return repos, nil
	}
}
