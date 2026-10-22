package forgejo

import "container/list"

// lru is a map that lets its least recently read entries go once it holds more
// than max. It does no locking: the cache that owns it does.
type lru[V any] struct {
	max   int
	items map[string]*list.Element
	order *list.List // front is the most recently read
}

type lruEntry[V any] struct {
	key string
	val V
}

func newLRU[V any](limit int) *lru[V] {
	return &lru[V]{max: limit, items: map[string]*list.Element{}, order: list.New()}
}

func (l *lru[V]) get(key string) (V, bool) {
	el, ok := l.items[key]
	if !ok {
		var zero V

		return zero, false
	}
	l.order.MoveToFront(el)

	return el.Value.(*lruEntry[V]).val, true
}

// peek is get without counting as a read.
func (l *lru[V]) peek(key string) (V, bool) {
	el, ok := l.items[key]
	if !ok {
		var zero V

		return zero, false
	}

	return el.Value.(*lruEntry[V]).val, true
}

func (l *lru[V]) put(key string, v V) {
	if el, ok := l.items[key]; ok {
		el.Value.(*lruEntry[V]).val = v
		l.order.MoveToFront(el)

		return
	}
	l.items[key] = l.order.PushFront(&lruEntry[V]{key: key, val: v})
	for l.order.Len() > l.max {
		oldest := l.order.Back()
		l.order.Remove(oldest)
		delete(l.items, oldest.Value.(*lruEntry[V]).key)
	}
}

func (l *lru[V]) remove(key string) {
	if el, ok := l.items[key]; ok {
		l.order.Remove(el)
		delete(l.items, key)
	}
}
