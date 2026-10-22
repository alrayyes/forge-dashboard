package forgejo

import "slices"

// lru is a map that lets its least recently read entries go once it holds more
// than max. It does no locking: the cache that owns it does.
type lru[V any] struct {
	max   int
	items map[string]V
	order []string // keys, least recently read first
}

func newLRU[V any](limit int) *lru[V] {
	return &lru[V]{max: limit, items: map[string]V{}}
}

func (l *lru[V]) get(key string) (V, bool) {
	v, ok := l.items[key]
	if ok {
		l.touch(key)
	}

	return v, ok
}

func (l *lru[V]) put(key string, v V) {
	if _, ok := l.items[key]; ok {
		l.touch(key)
	} else {
		l.order = append(l.order, key)
	}
	l.items[key] = v
	for len(l.order) > l.max {
		delete(l.items, l.order[0])
		l.order = l.order[1:]
	}
}

func (l *lru[V]) remove(key string) {
	if _, ok := l.items[key]; !ok {
		return
	}
	delete(l.items, key)
	if i := slices.Index(l.order, key); i >= 0 {
		l.order = slices.Delete(l.order, i, i+1)
	}
}

// touch moves key to the end of the order, as the most recently read.
func (l *lru[V]) touch(key string) {
	if i := slices.Index(l.order, key); i >= 0 {
		l.order = append(slices.Delete(l.order, i, i+1), key)
	}
}
