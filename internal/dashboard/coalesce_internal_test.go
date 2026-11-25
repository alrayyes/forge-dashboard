package dashboard

import (
	"runtime"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
)

// waiting counts the callers parked on the in-flight run, so a test can hold
// that run until every other caller has actually reached the coalescer rather
// than merely been started.
func TestCoalescer_WaitingCountsCallersParkedOnTheInFlightRun(t *testing.T) {
	t.Parallel()

	c := newCoalescer()
	assert.Zero(t, c.waiting())

	entered := make(chan struct{})
	release := make(chan struct{})
	var wg sync.WaitGroup
	var once sync.Once
	wg.Go(func() {
		c.do(func() {
			once.Do(func() { close(entered) })
			<-release
		})
	})
	<-entered
	assert.Zero(t, c.waiting(), "the caller running the fetch is not waiting")

	const others = 3
	for range others {
		wg.Go(func() { c.do(func() {}) })
	}
	for c.waiting() < others {
		runtime.Gosched()
	}
	assert.Equal(t, others, c.waiting())

	close(release)
	wg.Wait()
	assert.Zero(t, c.waiting(), "nobody is left waiting once the runs finish")
}
