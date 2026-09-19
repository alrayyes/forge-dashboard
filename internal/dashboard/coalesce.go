package dashboard

import "sync"

// coalescer runs one fn at a time, guaranteeing every caller a run that
// started at or after its own call returns before it does — not a
// redundant run per caller, and not a caller left with nothing at all.
//
// Real incident this exists for: a webhook delivery, a scheduled tick,
// and another webhook landing at once for the same user each ran their
// own full fetch against the real API with nothing preventing the
// overlap, multiplying request volume by however many triggers happened
// to stack up. The naive fix — drop a call if one's already running —
// trades that for a worse bug: a call arriving in the narrow window
// between an in-flight run's own work finishing and the run itself being
// marked done gets no run at all, not a redundant one. do blocks instead:
// a call arriving while a run is in flight marks one more run pending and
// waits for a run that began after it arrived, so every call is
// guaranteed to see its own trigger reflected. Any number of calls
// arriving during the same in-flight run still coalesce into exactly one
// trailing run they all wait on together, not one each.
type coalescer struct {
	mu   sync.Mutex
	cond *sync.Cond

	running bool
	pending bool
	// startedEpoch counts runs begun, completedEpoch counts runs
	// finished. A caller arriving mid-run records the epoch already
	// in flight and waits for completedEpoch to pass it — one past,
	// specifically, since the in-flight run started before the caller
	// arrived and can't be trusted to reflect whatever prompted the
	// call.
	startedEpoch   int64
	completedEpoch int64
}

func newCoalescer() *coalescer {
	c := &coalescer{}
	c.cond = sync.NewCond(&c.mu)

	return c
}

// do runs fn, or waits for a run guaranteed to have started after do was
// called. See the type's own doc comment for the guarantee this provides.
func (c *coalescer) do(fn func()) {
	c.mu.Lock()
	if c.running {
		c.pending = true
		arrivedAfter := c.startedEpoch
		for c.completedEpoch <= arrivedAfter {
			c.cond.Wait()
		}
		c.mu.Unlock()

		return
	}
	c.running = true
	c.startedEpoch++
	c.mu.Unlock()

	for {
		fn()

		c.mu.Lock()
		c.completedEpoch = c.startedEpoch
		c.cond.Broadcast()
		if !c.pending {
			c.running = false
			c.mu.Unlock()

			return
		}
		c.pending = false
		c.startedEpoch++
		c.mu.Unlock()
	}
}

// keyedCoalescer is a coalescer per key, so unrelated keys (two different
// repos, say) never wait on each other — only calls sharing the same key
// coalesce.
type keyedCoalescer struct {
	mu    sync.Mutex
	byKey map[string]*coalescer
}

func newKeyedCoalescer() *keyedCoalescer {
	return &keyedCoalescer{byKey: make(map[string]*coalescer)}
}

func (k *keyedCoalescer) do(key string, fn func()) {
	k.mu.Lock()
	c, ok := k.byKey[key]
	if !ok {
		c = newCoalescer()
		k.byKey[key] = c
	}
	k.mu.Unlock()

	c.do(fn)
}
