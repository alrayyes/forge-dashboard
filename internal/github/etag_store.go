package github

import (
	"container/list"
	"context"
	"log/slog"
	"net/http"
	"sync"
	"time"
)

const (
	// maxETagBodyBytes is the largest body the cache keeps. A bigger one is
	// served as usual and simply never cached, so it costs a full response
	// each time.
	maxETagBodyBytes = 1 << 20
	// maxETagTotalBytes bounds the bodies held across every entry.
	maxETagTotalBytes = 32 << 20
	// maxETagEntries bounds the number of entries.
	maxETagEntries = 5000
	// etagTouchInterval is how often a row that keeps answering 304 is marked
	// used in the backing. Marking it on every 304 would write on each poll.
	etagTouchInterval = 10 * time.Minute
)

// etagKey names one cached answer. Credential is a label (apistats.Credential*),
// never a secret or a user id.
type etagKey struct {
	forge      string
	credential string
	url        string
	accept     string
}

// ETagBacking keeps cached responses across restarts. A store reads through to
// it on a miss and writes to it on every response it caches. Rows are keyed by
// forge, credential label, URL and Accept header, never by user.
type ETagBacking interface {
	LoadETag(ctx context.Context, forge, credential, url, accept string) (etag string, body []byte, header map[string][]string, ok bool, err error)
	SaveETag(ctx context.Context, forge, credential, url, accept, etag string, body []byte, header map[string][]string) error
	// TouchETag marks a stored row as just used, so the least recently used
	// are the ones the backing evicts.
	TouchETag(ctx context.Context, forge, credential, url, accept string) error
}

type etagItem struct {
	key  etagKey
	resp cachedResponse
	// touchedAt is when the backing last saw this entry used; zero if it
	// hasn't since it was loaded from there.
	touchedAt time.Time
}

// etagStore holds cached responses for every Client in the process. It evicts
// the least recently used entry once it passes its entry or byte limit.
type etagStore struct {
	mu         sync.Mutex
	maxEntries int
	maxBytes   int
	bytes      int
	order      *list.List // front is the most recently used
	items      map[etagKey]*list.Element
	// backing is nil until SetETagBacking is called; the store is then memory only.
	backing ETagBacking
}

func newETagStore(maxEntries, maxBytes int) *etagStore {
	return &etagStore{
		maxEntries: maxEntries,
		maxBytes:   maxBytes,
		order:      list.New(),
		items:      make(map[etagKey]*list.Element),
	}
}

func (s *etagStore) get(ctx context.Context, k etagKey) (cachedResponse, bool) {
	if v, ok := s.getMemory(k); ok {
		return v, true
	}
	v, ok := s.load(ctx, k)
	if ok {
		s.putMemory(k, v, time.Time{})
	}

	return v, ok
}

func (s *etagStore) getMemory(k etagKey) (cachedResponse, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	el, ok := s.items[k]
	if !ok {
		return cachedResponse{}, false
	}
	s.order.MoveToFront(el)

	return el.Value.(*etagItem).resp, true //nolint:forcetypeassert // only etagItems are stored
}

// load reads k from the backing. An unreadable row is a miss, never an error
// for the request that asked.
func (s *etagStore) load(ctx context.Context, k etagKey) (cachedResponse, bool) {
	if s.backing == nil {
		return cachedResponse{}, false
	}
	etag, body, header, ok, err := s.backing.LoadETag(ctx, k.forge, k.credential, k.url, k.accept)
	if err != nil {
		slog.Debug("persisted ETag unreadable, asking without it", "forge", k.forge, "error", err)

		return cachedResponse{}, false
	}
	if !ok || etag == "" {
		return cachedResponse{}, false
	}

	return cachedResponse{etag: etag, body: body, header: http.Header(header)}, true
}

// used notes that k just answered a 304. The backing hears of it at most once
// per etagTouchInterval.
func (s *etagStore) used(ctx context.Context, k etagKey) {
	if s.backing == nil {
		return
	}
	s.mu.Lock()
	el, ok := s.items[k]
	if !ok {
		s.mu.Unlock()

		return
	}
	item := el.Value.(*etagItem) //nolint:forcetypeassert // only etagItems are stored
	now := time.Now()
	if !item.touchedAt.IsZero() && now.Sub(item.touchedAt) < etagTouchInterval {
		s.mu.Unlock()

		return
	}
	item.touchedAt = now
	s.mu.Unlock()

	if err := s.backing.TouchETag(ctx, k.forge, k.credential, k.url, k.accept); err != nil {
		slog.Debug("could not mark the persisted ETag used", "forge", k.forge, "error", err)
	}
}

func (s *etagStore) put(ctx context.Context, k etagKey, v cachedResponse) {
	s.putMemory(k, v, time.Now())
	if s.backing == nil {
		return
	}
	if err := s.backing.SaveETag(ctx, k.forge, k.credential, k.url, k.accept, v.etag, v.body, v.header); err != nil {
		slog.Debug("could not persist the ETag", "forge", k.forge, "error", err)
	}
}

func (s *etagStore) putMemory(k etagKey, v cachedResponse, touched time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if el, ok := s.items[k]; ok {
		item := el.Value.(*etagItem) //nolint:forcetypeassert // only etagItems are stored
		s.bytes += len(v.body) - len(item.resp.body)
		item.resp = v
		item.touchedAt = touched
		s.order.MoveToFront(el)
	} else {
		s.items[k] = s.order.PushFront(&etagItem{key: k, resp: v, touchedAt: touched})
		s.bytes += len(v.body)
	}
	for s.order.Len() > s.maxEntries || s.bytes > s.maxBytes {
		oldest := s.order.Back()
		if oldest == nil {
			break
		}
		item := s.order.Remove(oldest).(*etagItem) //nolint:forcetypeassert // only etagItems are stored
		delete(s.items, item.key)
		s.bytes -= len(item.resp.body)
	}
}

// sharedETags is the process-wide store every Client uses.
var sharedETags = newETagStore(maxETagEntries, maxETagTotalBytes)

// SetETagBacking keeps the process-wide ETag cache in b as well as in memory,
// so a restart finds the answers again. Call it once at start, before any
// Client carries traffic.
func SetETagBacking(b ETagBacking) {
	sharedETags.mu.Lock()
	defer sharedETags.mu.Unlock()
	sharedETags.backing = b
}
