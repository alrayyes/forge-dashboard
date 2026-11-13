package api

import (
	"net/url"
	"slices"
	"strings"
	"sync"
	"time"
)

const (
	defaultSkippedAvatarTTL = 10 * time.Minute
	// maxSkippedAvatarHosts bounds the memory a stream of odd avatar hosts can
	// take. Past it the one seen longest ago is forgotten.
	maxSkippedAvatarHosts = 8
)

// skippedAvatars remembers which hosts a Forgejo avatar was refused for, so
// Settings can say why an author shows an initial (#3683). It is a fact the
// server holds, not a decision: a host is listed while it keeps being refused
// and falls off once nothing has asked for it for a while.
type skippedAvatars struct {
	mu   sync.Mutex
	ttl  time.Duration
	now  func() time.Time
	seen map[string]time.Time
}

func newSkippedAvatars(ttl time.Duration, now func() time.Time) *skippedAvatars {
	if ttl <= 0 {
		ttl = defaultSkippedAvatarTTL
	}

	return &skippedAvatars{ttl: ttl, now: now, seen: map[string]time.Time{}}
}

// noteURL records the host of raw, an avatar address the proxy refused.
func (s *skippedAvatars) noteURL(raw string) {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return
	}
	s.note(strings.ToLower(u.Host))
}

func (s *skippedAvatars) note(host string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.seen[host] = s.now()
	for len(s.seen) > maxSkippedAvatarHosts {
		oldest := ""
		for h, at := range s.seen {
			if oldest == "" || at.Before(s.seen[oldest]) {
				oldest = h
			}
		}
		delete(s.seen, oldest)
	}
}

// hosts lists, sorted, the hosts refused within the TTL, leaving out
// instanceHost: an avatar there is served, so a stale entry from before the
// saved instance changed must not be reported. Never nil.
func (s *skippedAvatars) hosts(instanceHost string) []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []string{}
	cutoff := s.now().Add(-s.ttl)
	for h, at := range s.seen {
		if !at.After(cutoff) {
			delete(s.seen, h)

			continue
		}
		if h != strings.ToLower(instanceHost) {
			out = append(out, h)
		}
	}
	slices.Sort(out)

	return out
}

// skippedAvatarHosts is the list for a settings payload, given the saved
// instance URL.
func skippedAvatarHosts(deps Deps, forgejoURL string) []string {
	if deps.skipped == nil {
		return []string{}
	}
	host := ""
	if u, err := url.Parse(forgejoURL); err == nil {
		host = u.Host
	}

	return deps.skipped.hosts(host)
}
