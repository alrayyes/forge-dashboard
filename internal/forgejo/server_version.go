package forgejo

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
)

const (
	// versionProbeTimeout bounds one read of the instance's version, on top of
	// whatever deadline the caller's context carries.
	versionProbeTimeout = 3 * time.Second
	// blockedVersionTTL is how long an "older than the rerun route" answer is
	// trusted. An instance that upgrades unhides the button within this time,
	// or at once on a click.
	blockedVersionTTL = time.Hour
	// versionRetryAfter is how long a failed read is left alone before the next
	// try, so a dead forge is not asked on every refresh.
	versionRetryAfter = 30 * time.Second
)

// versionCache remembers the instance's major version. The zero value works.
// No lock is held while the network is asked.
type versionCache struct {
	mu       sync.Mutex
	major    int
	known    bool
	readAt   time.Time
	failedAt time.Time
	// flight is open while a read is under way, so a second caller waits for
	// that read instead of sending its own. Nil when none is.
	flight chan struct{}
	// now, probes and parked exist for the tests: a clock they move, a way to
	// wait for the background read, and a signal that a click is waiting on one.
	now    func() time.Time
	probes sync.WaitGroup
	parked func()
}

func (v *versionCache) clock() time.Time {
	if v.now != nil {
		return v.now()
	}

	return time.Now()
}

// answerLocked is the cached major version and whether it can still be
// trusted. A recent failure counts as trusted, so it is not repeated at once.
func (v *versionCache) answerLocked() (major int, known, fresh bool) {
	now := v.clock()
	switch {
	case !v.failedAt.IsZero() && now.Sub(v.failedAt) < versionRetryAfter:
		fresh = true
	case !v.known:
		fresh = false
	case v.major >= firstRerunMajor || v.major < firstForgejoMajor:
		// An answer that can't change what is done is kept: 17 and later have
		// the route for good, and a 1.x is a Gitea or an old Forgejo that is
		// left to the forge whatever its number.
		fresh = true
	default:
		fresh = now.Sub(v.readAt) < blockedVersionTTL
	}

	return v.major, v.known, fresh
}

// peek is the cached answer, and whether a refresh should start a read.
func (v *versionCache) peek() (major int, known, startRead bool) {
	v.mu.Lock()
	defer v.mu.Unlock()
	major, known, fresh := v.answerLocked()
	if fresh || v.flight != nil {
		return major, known, false
	}
	v.flight = make(chan struct{})
	v.probes.Add(1)

	return major, known, true
}

// join is the read under way to wait for. With none, and an answer that has
// gone stale, it takes the right to start one and returns lead: the caller then
// reads and calls land. The freshness check shares the lock with taking the
// flight, so a read that landed a moment ago is not sent again.
func (v *versionCache) join() (wait <-chan struct{}, lead bool) {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.flight != nil {
		return v.flight, false
	}
	if _, _, fresh := v.answerLocked(); fresh {
		return nil, false
	}
	v.flight = make(chan struct{})

	return nil, true
}

// land ends the read under way and lets its waiters go.
func (v *versionCache) land() {
	v.mu.Lock()
	defer v.mu.Unlock()
	close(v.flight)
	v.flight = nil
}

func (v *versionCache) answer() (major int, known, fresh bool) {
	v.mu.Lock()
	defer v.mu.Unlock()

	return v.answerLocked()
}

func (v *versionCache) record(major int, ok bool) {
	v.mu.Lock()
	defer v.mu.Unlock()
	if !ok {
		v.failedAt = v.clock()
		// A block that has gone stale is not served on trust while the forge
		// can't be asked: the rerun is left to the forge until a read lands.
		if v.major >= firstForgejoMajor && v.major < firstRerunMajor {
			v.known = false
		}

		return
	}
	v.major, v.known, v.readAt, v.failedAt = major, true, v.clock(), time.Time{}
}

// readVersion asks the forge for its version under ctx and remembers the
// answer. A read the caller cancelled says nothing about the forge.
func (c *Client) readVersion(ctx context.Context) {
	probeCtx, cancel := context.WithTimeout(ctx, versionProbeTimeout)
	defer cancel()
	body, resp, err := c.rawRequest(probeCtx, http.MethodGet, "/version", nil)
	if err != nil {
		if ctx.Err() == nil {
			// An answer from the forge is classified like any forge call, so a
			// 429 counts as rate limiting. A read that got no answer (a timeout,
			// a refused connection) adds nothing to the log.
			if resp != nil {
				_ = c.forgejoError(ctx, http.MethodGet, "/version", resp, err)
			}
			c.version.record(0, false)
		}

		return
	}
	var v struct {
		Version string `json:"version"`
	}
	if json.Unmarshal(body, &v) != nil {
		c.version.record(0, false)

		return
	}
	major, _, _ := strings.Cut(strings.TrimPrefix(v.Version, "v"), ".")
	n, _ := strconv.Atoi(major)
	// A version in words, or none, says nothing about the instance: it is
	// read again later like a failed read.
	c.version.record(n, n > 0)
}

// startVersionRead reads the version in the background, so a refresh never
// waits on the forge for it.
func (c *Client) startVersionRead() {
	go func() {
		defer c.version.probes.Done()
		defer c.version.land()
		c.readVersion(context.Background())
	}()
}

// serverMajor is the cached major version for a refresh: it answers at once
// and starts a read in the background when the answer has gone stale.
func (c *Client) serverMajor() (int, bool) {
	major, known, start := c.version.peek()
	if start {
		c.startVersionRead()
	}

	return major, known && major >= firstForgejoMajor
}

// serverMajorFor is the major version for a click: a stale answer is read
// again under the caller's context before it decides anything. A click whose
// context ends while it waits for another's read, or during its own, gets that
// error as an unreachable forge, since it has nothing to decide on.
//
// Waiters never probe in parallel: one takes the flight and the rest wait on
// it. They probe one after another only when each leader's own context ended
// before its read did, which a read that landed (or failed) does not cause, so
// the forge is asked at most once per cancelled leader.
func (c *Client) serverMajorFor(ctx context.Context) (int, bool, error) {
	for {
		if _, _, fresh := c.version.answer(); fresh {
			break
		}
		wait, lead := c.version.join()
		if lead {
			c.readAsLeader(ctx)
			// A read that landed an answer before the context ended is still good.
			if _, _, fresh := c.version.answer(); !fresh && ctx.Err() != nil {
				return 0, false, versionWaitError(ctx.Err())
			}

			break
		}
		if wait == nil {
			break
		}
		if err := c.version.await(ctx, wait); err != nil {
			return 0, false, err
		}
	}
	major, known, _ := c.version.answer()

	return major, known && major >= firstForgejoMajor, nil
}

// await waits for the read under way to land, or for ctx to end. A read that
// landed may have been cancelled and said nothing, so the caller looks at the
// answer again instead of trusting it.
func (v *versionCache) await(ctx context.Context, wait <-chan struct{}) error {
	if v.parked != nil {
		v.parked()
	}
	select {
	case <-wait:
		return nil
	case <-ctx.Done():
		return versionWaitError(ctx.Err())
	}
}

// readAsLeader reads the version under ctx for a click that took the flight.
// Deferred, so a read that panics still closes it.
func (c *Client) readAsLeader(ctx context.Context) {
	defer c.version.land()
	c.readVersion(ctx)
}

// versionWaitError is the refusal for a click that gave up on the version: the
// forge was not heard from, which is how a person is told.
func versionWaitError(err error) error {
	return &dashboard.ClientError{
		Kind: dashboard.ForgeErrorUnreachable,
		Err:  fmt.Errorf("wait for the forge's version: %w", err),
	}
}
