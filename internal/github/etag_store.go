package github

import (
	"container/list"
	"sync"
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
)

// etagKey names one cached answer. Credential is a label (apistats.Credential*),
// never a secret or a user id.
type etagKey struct {
	forge      string
	credential string
	url        string
	accept     string
}

type etagItem struct {
	key  etagKey
	resp cachedResponse
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
}

func newETagStore(maxEntries, maxBytes int) *etagStore {
	return &etagStore{
		maxEntries: maxEntries,
		maxBytes:   maxBytes,
		order:      list.New(),
		items:      make(map[etagKey]*list.Element),
	}
}

func (s *etagStore) get(k etagKey) (cachedResponse, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	el, ok := s.items[k]
	if !ok {
		return cachedResponse{}, false
	}
	s.order.MoveToFront(el)

	return el.Value.(*etagItem).resp, true //nolint:forcetypeassert // only etagItems are stored
}

func (s *etagStore) put(k etagKey, v cachedResponse) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if el, ok := s.items[k]; ok {
		item := el.Value.(*etagItem) //nolint:forcetypeassert // only etagItems are stored
		s.bytes += len(v.body) - len(item.resp.body)
		item.resp = v
		s.order.MoveToFront(el)
	} else {
		s.items[k] = s.order.PushFront(&etagItem{key: k, resp: v})
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
