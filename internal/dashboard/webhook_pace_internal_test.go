package dashboard

import (
	"runtime"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

// A second charge made while the first is still on adds to it. Replacing it
// would leave one run's cost unpaid.
func TestDebouncer_Charge_AddsToTheHoldAlreadyOn(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	d := newDebouncer(t.Context(), func() time.Time { return now }, realAfterFunc, 0, 0, 0)

	d.charge("k", now, time.Minute)
	d.charge("k", now.Add(10*time.Second), time.Minute)
	until, held := d.heldUntil("k")

	assert.True(t, held)
	assert.Equal(t, now.Add(2*time.Minute), until)
}

// The trailing run is made for the highest-ranked caller waiting for it,
// whatever order they came in, and not for the one already running.
func TestCoalescer_TheTrailingRunIsTheHighestRankedCallers(t *testing.T) {
	t.Parallel()
	c := newCoalescer()
	entered, release := make(chan struct{}), make(chan struct{})
	var mu sync.Mutex
	var ran []string
	record := func(name string) func() {
		return func() {
			mu.Lock()
			defer mu.Unlock()
			ran = append(ran, name)
		}
	}
	var wg sync.WaitGroup
	wg.Go(func() {
		c.doRanked(1, func() {
			record("running")()
			close(entered)
			<-release
		})
	})
	<-entered

	for i, joiner := range []struct {
		rank int
		name string
	}{{2, "poll"}, {1, "delivery"}} {
		wg.Go(func() { c.doRanked(joiner.rank, record(joiner.name)) })
		for c.waiting() <= i {
			runtime.Gosched()
		}
	}
	close(release)
	wg.Wait()

	assert.Equal(t, []string{"running", "poll"}, ran)
}
