package api

import (
	"context"
	"errors"
	"net/url"
	"sync"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/imageproxy"
)

const (
	defaultImageConcurrency = 8
	defaultImageQueueWait   = 5 * time.Second
	defaultImageCacheTTL    = 5 * time.Minute
	// The cache holds at most this many images and bytes, so it can't grow
	// with the number of distinct addresses a page asks for.
	imageCacheEntries = 512
	imageCacheBytes   = 32 << 20
)

// imageKind is what a proxied image is for. It picks the size cap: an avatar
// or repository logo is never drawn large, an embedded image can be (#3687).
type imageKind string

const (
	imageEmbedded imageKind = ""
	imageAvatar   imageKind = "avatar"
)

func (k imageKind) maxBytes() int {
	if k == imageAvatar {
		return imageproxy.MaxAvatarBytes
	}

	return imageproxy.MaxBytes
}

// imageLimits bounds what the image proxy costs: how many upstream fetches run
// at once, and a short-lived cache so a repeated request costs none.
type imageLimits struct {
	slots chan struct{}
	wait  time.Duration
	ttl   time.Duration

	mu    sync.Mutex
	items map[imageKey]cachedImage
	order []imageKey // oldest first
	bytes int
}

type imageKey struct {
	forge string
	kind  imageKind
	url   string
	width string // validated by the handler; empty is the original bytes
}

type cachedImage struct {
	img     imageproxy.Image
	expires time.Time
}

var errImageBusy = errors.New("no image fetch slot freed in time")

// load returns the image for raw: from the cache when it holds a fresh copy,
// else fetched while holding a slot, which is errImageBusy if none frees up.
func (l *imageLimits) load(ctx context.Context, q url.Values, raw string, fetch func(context.Context, imageKind) (imageproxy.Image, error)) (imageproxy.Image, error) {
	kind := imageEmbedded
	if q.Get("kind") == string(imageAvatar) {
		kind = imageAvatar
	}
	key := imageKey{forge: q.Get("forge"), kind: kind, url: raw, width: q.Get("width")}
	if img, ok := l.get(key); ok {
		return img, nil
	}
	if !l.acquire(ctx) {
		return imageproxy.Image{}, errImageBusy
	}
	defer l.release()
	// A request that queued behind the same address finds it cached now.
	if img, ok := l.get(key); ok {
		return img, nil
	}
	img, err := fetch(ctx, kind)
	if err != nil {
		return imageproxy.Image{}, err
	}
	l.put(key, img)

	return img, nil
}

func newImageLimits(deps Deps) *imageLimits {
	n, wait, ttl := deps.ImageConcurrency, deps.ImageQueueWait, deps.ImageCacheTTL
	if n <= 0 {
		n = defaultImageConcurrency
	}
	if wait <= 0 {
		wait = defaultImageQueueWait
	}
	if ttl <= 0 {
		ttl = defaultImageCacheTTL
	}

	return &imageLimits{slots: make(chan struct{}, n), wait: wait, ttl: ttl, items: map[imageKey]cachedImage{}}
}

// acquire waits for a fetch slot, at most the queue wait. It reports false when
// the wait ran out or ctx ended; release must be called only after true.
func (l *imageLimits) acquire(ctx context.Context) bool {
	timer := time.NewTimer(l.wait)
	defer timer.Stop()
	select {
	case l.slots <- struct{}{}:
		return true
	case <-timer.C:
		return false
	case <-ctx.Done():
		return false
	}
}

func (l *imageLimits) release() { <-l.slots }

func (l *imageLimits) get(k imageKey) (imageproxy.Image, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	c, ok := l.items[k]
	if !ok || !time.Now().Before(c.expires) {
		return imageproxy.Image{}, false
	}

	return c.img, true
}

func (l *imageLimits) put(k imageKey, img imageproxy.Image) {
	if len(img.Data) > imageCacheBytes/4 {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if old, ok := l.items[k]; ok {
		l.bytes -= len(old.img.Data)
		l.drop(k)
	}
	for len(l.order) > 0 && (len(l.order) >= imageCacheEntries || l.bytes+len(img.Data) > imageCacheBytes) {
		oldest := l.order[0]
		l.bytes -= len(l.items[oldest].img.Data)
		l.drop(oldest)
	}
	l.items[k] = cachedImage{img: img, expires: time.Now().Add(l.ttl)}
	l.order = append(l.order, k)
	l.bytes += len(img.Data)
}

// drop removes k from the map and the order list; the caller holds mu.
func (l *imageLimits) drop(k imageKey) {
	delete(l.items, k)
	for i, o := range l.order {
		if o == k {
			l.order = append(l.order[:i], l.order[i+1:]...)

			break
		}
	}
}
