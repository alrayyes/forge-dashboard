package api

import (
	"container/list"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
)

// jobLogSettleDelay is how long after a job finishes its log is trusted to be
// complete: the runner may still be flushing its last lines just after. It is
// the wait the Forgejo client gives a failed job's excerpt.
const jobLogSettleDelay = 30 * time.Second

// jobLogCacheBytes bounds what the server keeps of finished logs. One log is at
// most dashboard.MaxJobLogBytes, so this holds at least a hundred of them.
const jobLogCacheBytes = 32 << 20

// jobLogKey names one run of one job: its place, id, attempt and finish time,
// so a rerun, which finishes again later and may keep its job id, reads fresh.
type jobLogKey struct {
	forge      string
	fullName   string
	jobID      int64
	attempt    int64
	finishedAt time.Time
}

func (k jobLogKey) String() string {
	return strings.Join([]string{
		k.forge, strings.ToLower(k.fullName),
		strconv.FormatInt(k.jobID, 10), strconv.FormatInt(k.attempt, 10), strconv.FormatInt(k.finishedAt.UnixNano(), 10),
	}, "|")
}

// jobLogSettled reports whether a job that finished at finishedAt has a final
// log at now. A job with no finish time is still running or unknown; a finish
// in the future is a clock that disagrees with ours. Neither is kept.
func jobLogSettled(finishedAt, now time.Time) bool {
	return !finishedAt.IsZero() && now.Sub(finishedAt) >= jobLogSettleDelay
}

// jobLogCache keeps the logs of finished jobs in memory, up to a byte budget,
// the least recently read going first.
type jobLogCache struct {
	mu    sync.Mutex
	max   int
	size  int
	items map[string]*list.Element
	order *list.List // front is the most recently read
}

type keptJobLog struct {
	key string
	log dashboard.JobLog
}

func newJobLogCache(maxBytes int) *jobLogCache {
	return &jobLogCache{max: maxBytes, items: map[string]*list.Element{}, order: list.New()}
}

func (c *jobLogCache) get(k jobLogKey) (dashboard.JobLog, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	el, ok := c.items[k.String()]
	if !ok {
		return dashboard.JobLog{}, false
	}
	c.order.MoveToFront(el)

	return el.Value.(*keptJobLog).log, true
}

func (c *jobLogCache) put(k jobLogKey, log dashboard.JobLog) {
	n := len(log.Text)
	if n > c.max {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	key := k.String()
	if el, ok := c.items[key]; ok {
		c.size -= len(el.Value.(*keptJobLog).log.Text)
		c.order.Remove(el)
		delete(c.items, key)
	}
	c.items[key] = c.order.PushFront(&keptJobLog{key: key, log: log})
	c.size += n
	for c.size > c.max {
		oldest := c.order.Back()
		kept := c.order.Remove(oldest).(*keptJobLog)
		delete(c.items, kept.key)
		c.size -= len(kept.log.Text)
	}
}
