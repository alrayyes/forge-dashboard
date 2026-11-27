package github

import (
	"strings"
	"sync"
)

// statusPresenceMax bounds the cache. Reaching it empties the cache, which
// costs one status read per commit until the next poll fills it again.
const statusPresenceMax = 10000

// StatusPresenceCache remembers, per commit, whether a row's GraphQL rollup
// counted any commit status, so a checks list can skip the status read when it
// did not (#5101). A commit it knows nothing about is read.
type StatusPresenceCache struct {
	mu   sync.Mutex
	seen map[string]bool
}

// NewStatusPresenceCache returns an empty cache.
func NewStatusPresenceCache() *StatusPresenceCache {
	return &StatusPresenceCache{seen: map[string]bool{}}
}

// ShareStatusPresenceCache makes this Client use cache, so what a poll's Client
// saw reaches the Client that lists a commit's checks.
func (c *Client) ShareStatusPresenceCache(cache *StatusPresenceCache) {
	c.statusPresence = cache
}

func statusPresenceKey(fullName, sha string) string {
	return strings.ToLower(fullName) + "@" + sha
}

// note records what a rollup of the commit counted. A rollup that says nothing
// about its contexts records nothing. A commit never loses a status, so one
// seen once stays: a later rollup without it was read with less access.
func (s *StatusPresenceCache) note(fullName, sha string, r *statusCheckRollup) {
	if sha == "" || r == nil || r.Contexts == nil {
		return
	}
	has := r.hasStatuses()
	key := statusPresenceKey(fullName, sha)

	s.mu.Lock()
	defer s.mu.Unlock()

	old, known := s.seen[key]
	if !known && len(s.seen) >= statusPresenceMax {
		clear(s.seen)
	}
	s.seen[key] = old || has
}

// none reports that a rollup of the commit was seen and counted no status.
func (s *StatusPresenceCache) none(fullName, sha string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()

	has, known := s.seen[statusPresenceKey(fullName, sha)]

	return known && !has
}

// hasStatuses reports that the commit has a commit status, as GitHub counted
// them before keepNewestRuns rebuilt the counts.
func (r *statusCheckRollup) hasStatuses() bool {
	if r.statusesCounted {
		return true
	}
	for _, c := range r.Contexts.StatusContextCountsByState {
		if c.Count > 0 {
			return true
		}
	}

	return false
}

// notePullRequestStatuses records what a pull request's rollup counted.
func (c *Client) notePullRequestStatuses(fullName string, p graphqlPullRequest) {
	for _, n := range p.Commits.Nodes {
		c.statusPresence.note(fullName, n.Commit.Oid, n.Commit.StatusCheckRollup)
	}
}

// noteBranchStatuses records what a default branch's rollup counted.
func (c *Client) noteBranchStatuses(fullName string, ref *graphqlBranchRef) {
	if ref != nil {
		c.statusPresence.note(fullName, ref.Target.OID, ref.Target.StatusCheckRollup)
	}
}
