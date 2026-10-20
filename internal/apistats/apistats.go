// Package apistats counts the forge API calls the dashboard spends, by forge,
// credential, refresh kind and repo, so a change to the refresh path can be
// shown to have saved budget. Counters live in memory and start at zero on
// each process start. A key never carries a user id.
package apistats

import (
	"context"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"
)

// Kind says why a request was made.
type Kind string

const (
	KindFull            Kind = "full"
	KindScopedWebhook   Kind = "scoped_webhook"
	KindCIPoll          Kind = "ci_poll"
	KindAutoMergePoll   Kind = "auto_merge_poll"
	KindDetails         Kind = "details"
	KindHookMaintenance Kind = "hook_maintenance"
	KindUserAction      Kind = "user_action"
	// KindUnknown marks a request nobody tagged. A test treats it as a
	// failure, so a new call path can't go uncounted by accident.
	KindUnknown Kind = "unknown"
)

// MaxBuckets bounds the number of distinct keys. Past it, a new key folds into
// one overflow row per forge, credential and kind, with the repo "other".
const MaxBuckets = 2000

// OverflowRepo is the repo a folded-away key is counted under.
const OverflowRepo = "other"

// Key is one counter row.
type Key struct {
	Forge      string `json:"forge"`
	Credential string `json:"credential"`
	Kind       Kind   `json:"kind"`
	Repo       string `json:"repo"`
}

// Count is what one row holds.
type Count struct {
	REST        int64 `json:"rest"`
	GraphQL     int64 `json:"graphql"`
	GraphQLCost int64 `json:"graphqlCost"`
	NotModified int64 `json:"notModified"`
}

// Bucket is a Key and its Count, as served.
type Bucket struct {
	Key
	Count
}

// Counters is safe for concurrent use. A nil *Counters accepts every call and
// records nothing, so a client built without stats keeps working.
type Counters struct {
	since time.Time

	mu sync.Mutex
	m  map[Key]*Count
}

// New returns zeroed Counters that say they started now.
func New() *Counters {
	return &Counters{since: time.Now().UTC(), m: make(map[Key]*Count)}
}

// Since is when counting began.
func (c *Counters) Since() time.Time {
	if c == nil {
		return time.Time{}
	}

	return c.since
}

// Add adds n to the row for key.
func (c *Counters) Add(key Key, n Count) {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()

	row, ok := c.m[key]
	if !ok {
		if len(c.m) >= MaxBuckets {
			key.Repo = OverflowRepo
			row = c.m[key]
		}
		if row == nil {
			row = &Count{}
			c.m[key] = row
		}
	}
	row.REST += n.REST
	row.GraphQL += n.GraphQL
	row.GraphQLCost += n.GraphQLCost
	row.NotModified += n.NotModified
}

// AddCost adds a GraphQL rateLimit.cost under the kind and repo ctx carries.
func (c *Counters) AddCost(ctx context.Context, forge, credential string, cost int) {
	if c == nil || cost <= 0 {
		return
	}
	c.Add(keyFor(ctx, forge, credential), Count{GraphQLCost: int64(cost)})
}

// Snapshot returns every row, ordered by forge, credential, kind and repo.
func (c *Counters) Snapshot() []Bucket {
	if c == nil {
		return nil
	}
	c.mu.Lock()
	out := make([]Bucket, 0, len(c.m))
	for k, v := range c.m {
		out = append(out, Bucket{Key: k, Count: *v})
	}
	c.mu.Unlock()

	slices.SortFunc(out, func(a, b Bucket) int {
		return strings.Compare(sortKey(a.Key), sortKey(b.Key))
	})

	return out
}

func sortKey(k Key) string {
	return k.Forge + "\x00" + k.Credential + "\x00" + string(k.Kind) + "\x00" + k.Repo
}

type ctxKey int

const (
	kindKey ctxKey = iota
	repoKey
)

// WithKind tags the requests made under ctx with why they are made.
func WithKind(ctx context.Context, kind Kind) context.Context {
	return context.WithValue(ctx, kindKey, kind)
}

// WithRepo tags the requests made under ctx with the repo they touch.
func WithRepo(ctx context.Context, repo string) context.Context {
	return context.WithValue(ctx, repoKey, repo)
}

// KindFrom returns the kind ctx carries, or KindUnknown.
func KindFrom(ctx context.Context) Kind {
	if k, ok := ctx.Value(kindKey).(Kind); ok && k != "" {
		return k
	}

	return KindUnknown
}

func keyFor(ctx context.Context, forge, credential string) Key {
	repo, _ := ctx.Value(repoKey).(string)

	return Key{Forge: forge, Credential: credential, Kind: KindFrom(ctx), Repo: repo}
}

type countingTransport struct {
	base       http.RoundTripper
	counters   *Counters
	forge      string
	credential string
}

// Transport wraps base so every request through it is counted under forge
// and credential. Put it below any cache that turns a 304 into a 200, so it
// sees the 304. With nil counters it returns base untouched; a nil base means
// http.DefaultTransport.
func Transport(base http.RoundTripper, counters *Counters, forge, credential string) http.RoundTripper {
	if base == nil {
		base = http.DefaultTransport
	}
	if counters == nil {
		return base
	}

	return &countingTransport{base: base, counters: counters, forge: forge, credential: credential}
}

func (t *countingTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	resp, err := t.base.RoundTrip(req)

	// A request that got no answer was still sent, so it counts as a call.
	var n Count
	switch {
	case err == nil && resp.StatusCode == http.StatusNotModified:
		n.NotModified = 1
	case strings.HasSuffix(req.URL.Path, "/graphql"):
		n.GraphQL = 1
	default:
		n.REST = 1
	}
	t.counters.Add(keyFor(req.Context(), t.forge, t.credential), n)

	return resp, err //nolint:wrapcheck // a transport passes the error through untouched
}
