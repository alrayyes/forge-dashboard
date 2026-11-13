package api

import (
	"context"
	"errors"
	"net/url"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/imageproxy"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func testLimits() *imageLimits {
	return newImageLimits(Deps{ImageConcurrency: 1, ImageQueueWait: 10 * time.Second})
}

func loadVia(l *imageLimits, raw string, fetch func(context.Context, imageKind) (imageproxy.Image, error)) (imageproxy.Image, error) {
	return l.load(context.Background(), url.Values{"forge": {"forgejo"}}, raw, fetch)
}

func TestImageLimits_CacheHoldsAtMostTheEntryBound(t *testing.T) {
	t.Parallel()
	l := testLimits()
	img := imageproxy.Image{ContentType: "image/png", Data: []byte{1}}
	for i := range imageCacheEntries + 10 {
		l.put(imageKey{forge: "forgejo", url: strconv.Itoa(i)}, img)
	}

	l.mu.Lock()
	defer l.mu.Unlock()
	assert.Len(t, l.items, imageCacheEntries)
	assert.Len(t, l.order, imageCacheEntries)
	assert.NotContains(t, l.items, imageKey{forge: "forgejo", url: "0"}, "the oldest is the one evicted")
}

func TestImageLimits_CacheHoldsAtMostTheByteBound(t *testing.T) {
	t.Parallel()
	l := testLimits()
	img := imageproxy.Image{ContentType: "image/png", Data: make([]byte, imageCacheBytes/5)}
	for i := range 12 {
		l.put(imageKey{forge: "forgejo", url: strconv.Itoa(i)}, img)
	}

	l.mu.Lock()
	defer l.mu.Unlock()
	assert.LessOrEqual(t, l.bytes, imageCacheBytes)
	assert.Less(t, len(l.items), 12, "older images were evicted to stay inside the byte bound")
}

func TestImageLimits_DoesNotCacheAFailure(t *testing.T) {
	t.Parallel()
	l := testLimits()
	var calls int
	fetch := func(context.Context, imageKind) (imageproxy.Image, error) {
		calls++

		return imageproxy.Image{}, errors.New("404")
	}

	_, err1 := loadVia(l, "https://x/a", fetch)
	_, err2 := loadVia(l, "https://x/a", fetch)

	require.Error(t, err1)
	require.Error(t, err2)
	assert.Equal(t, 2, calls, "a failed fetch is tried again")
}

func TestImageLimits_QueuedDuplicatesAreServedFromTheCache(t *testing.T) {
	t.Parallel()
	const waiters = 8
	l := testLimits()
	release := make(chan struct{})
	var fetches atomic.Int32
	fetch := func(context.Context, imageKind) (imageproxy.Image, error) {
		fetches.Add(1)
		<-release

		return imageproxy.Image{ContentType: "image/png", Data: []byte{1}}, context.Cause(context.Background())
	}

	var wg sync.WaitGroup
	for range waiters {
		wg.Go(func() {
			_, err := loadVia(l, "https://x/same", fetch)
			assert.NoError(t, err)
		})
	}
	require.Eventually(t, func() bool { return fetches.Load() == 1 }, 5*time.Second, 5*time.Millisecond)
	time.Sleep(100 * time.Millisecond) // let the rest queue behind the slot
	close(release)
	wg.Wait()

	assert.Equal(t, int32(1), fetches.Load(), "the queued requests find the first one's image in the cache")
}
