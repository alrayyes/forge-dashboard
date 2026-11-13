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

// renderedBodyCache keeps an item's rendered HTML for renderedBodyTTL, so every
// image in one description shares a single API request. Keys carry the
// credential, and a Client holds one, so another account never reads it.
// The zero value is ready to use.
type renderedBodyCache struct {
	mu      sync.Mutex
	entries map[string]*renderedEntry
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

func (c *renderedBodyCache) clock() time.Time {
	if c.now != nil {
		return c.now()
	}

	return time.Now()
}

// get returns the cached body for key, or the one load returns, which it then
// keeps. A failed load is not kept.
func (c *renderedBodyCache) get(ctx context.Context, key string, load func(context.Context) (string, error)) (string, error) {
	c.mu.Lock()
	if c.entries == nil {
		c.entries = map[string]*renderedEntry{}
	}
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
