package github

import (
	"context"
	"sync"
	"time"
)

// renderedBodyTTL is how long an item's rendered body is kept. The signed
// addresses inside it last five minutes, so this stays well under that and an
// address handed out is still good when the browser's fetch reaches it (#3682).
const renderedBodyTTL = 2 * time.Minute

// renderedBodyMax bounds the cache: past it, the entry closest to expiring
// makes room.
const renderedBodyMax = 256

// RenderedBodyCache keeps an item's rendered HTML for renderedBodyTTL, so every
// image in one description shares a single API request. Keys carry the
// credential, so one account never reads another's entry. It must outlive a
// request: share one instance across the clients a source builder makes
// (ShareRenderedBodyCache). Use NewRenderedBodyCache.
type RenderedBodyCache struct {
	mu      sync.Mutex
	entries map[string]*renderedEntry
	// max caps the entries; zero means renderedBodyMax. Only tests set it.
	max int
	// now is the clock; nil reads the wall clock. Only tests set it.
	now func() time.Time
}

// renderedEntry has its own lock so images of one item wait for one request
// while other items go on.
type renderedEntry struct {
	mu      sync.Mutex
	html    string
	expires time.Time
}

// NewRenderedBodyCache returns an empty cache.
func NewRenderedBodyCache() *RenderedBodyCache {
	return &RenderedBodyCache{entries: map[string]*renderedEntry{}}
}

func (c *RenderedBodyCache) limit() int {
	if c.max > 0 {
		return c.max
	}

	return renderedBodyMax
}

func (c *RenderedBodyCache) clock() time.Time {
	if c.now != nil {
		return c.now()
	}

	return time.Now()
}

// get returns the cached body for key, or the one load returns, which it then
// keeps. A failed load is not kept.
func (c *RenderedBodyCache) get(ctx context.Context, key string, load func(context.Context) (string, error)) (string, error) {
	c.mu.Lock()
	now := c.clock()
	for k, e := range c.entries {
		// A stale entry that is being loaded keeps its place: its holder
		// refreshes it in place.
		if e.mu.TryLock() {
			if !now.Before(e.expires) {
				delete(c.entries, k)
			}
			e.mu.Unlock()
		}
	}
	e, ok := c.entries[key]
	if !ok {
		for len(c.entries) >= c.limit() {
			if !c.evictOne() {
				break
			}
		}
		e = &renderedEntry{}
		c.entries[key] = e
	}
	c.mu.Unlock()

	e.mu.Lock()
	defer e.mu.Unlock()
	if c.clock().Before(e.expires) {
		return e.html, nil
	}
	html, err := load(ctx)
	if err != nil {
		return "", err
	}
	e.html, e.expires = html, c.clock().Add(renderedBodyTTL)

	return html, nil
}

// evictOne drops the entry that expires first and reports whether it dropped
// one. An entry mid-load is left alone. The caller holds c.mu.
func (c *RenderedBodyCache) evictOne() bool {
	var oldest string
	var when time.Time
	for k, e := range c.entries {
		if !e.mu.TryLock() {
			continue
		}
		exp := e.expires
		e.mu.Unlock()
		if oldest == "" || exp.Before(when) {
			oldest, when = k, exp
		}
	}
	if oldest == "" {
		return false
	}
	delete(c.entries, oldest)

	return true
}
