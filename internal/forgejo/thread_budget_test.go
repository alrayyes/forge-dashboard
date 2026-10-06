package forgejo_test

import (
	"bufio"
	"database/sql"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/auth"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/forgejo"
	"github.com/alrayyes/forge-dashboard/internal/requestlog"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	_ "modernc.org/sqlite"
)

const (
	// threadBudget is what the ticket asks for: the production container's
	// process limit counts threads, and the healthcheck is a second process
	// that needs room to start.
	threadBudget   = 30
	repoCount      = 50
	concurrentTabs = 6
)

// threads reads the process's thread count, the number a container's pid
// limit counts. It skips the test where /proc isn't there.
func threads(tb testing.TB) int {
	tb.Helper()

	f, err := os.Open("/proc/self/status")
	if err != nil {
		tb.Skip("no /proc/self/status on this platform")
	}
	defer func() { _ = f.Close() }()

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		if v, ok := strings.CutPrefix(scanner.Text(), "Threads:"); ok {
			n, err := strconv.Atoi(strings.TrimSpace(v))
			require.NoError(tb, err)

			return n
		}
	}
	tb.Fatal("no Threads: line in /proc/self/status")

	return 0
}

// stubForgejo answers like a Forgejo with repoCount repositories and nothing
// open on them, after a short delay so requests overlap the way real ones do.
func stubForgejo(t *testing.T) *httptest.Server {
	t.Helper()

	repos := make([]map[string]any, repoCount)
	for i := range repos {
		name := fmt.Sprintf("repo-%02d", i)
		repos[i] = map[string]any{
			"full_name":   "alrayyes/" + name,
			"name":        name,
			"owner":       map[string]string{"login": "alrayyes"},
			"permissions": map[string]bool{"push": true, "admin": true},
		}
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/user/repos", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, repos)
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		time.Sleep(5 * time.Millisecond)
		writeJSON(t, w, []map[string]any{})
	})

	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	return srv
}

// Not parallel: a parallel sibling's threads would count against the budget.
func TestRefresh_ManyReposAndTabs_StaysUnderTheThreadBudget(t *testing.T) {
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "auth.db")+"?_busy_timeout=5000&_journal_mode=WAL")
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })
	store := auth.NewStore(db)
	require.NoError(t, store.Init(t.Context()))

	writer := requestlog.NewWriter(store, 1000)
	t.Cleanup(writer.Close)
	recorder := requestlog.NewSQLiteRecorder(store, "", requestlog.WithWriter(writer))

	srv := stubForgejo(t)
	client := forgejo.NewClient(srv.URL, "test-token", "", recorder)
	source := dashboard.NewGenericSource(dashboard.ForgeForgejo, client, dashboard.DefaultMaxConcurrency)

	idle := threads(t)

	var peak atomic.Int64
	stop := make(chan struct{})
	sampled := make(chan struct{})
	go func() {
		defer close(sampled)
		for {
			select {
			case <-stop:
				return
			default:
				peak.Store(max(peak.Load(), int64(threads(t))))
				time.Sleep(2 * time.Millisecond)
			}
		}
	}()

	var wg sync.WaitGroup
	for range concurrentTabs {
		wg.Go(func() {
			result := source.Fetch(t.Context())
			assert.True(t, result.Health.Reachable, "the stub forge is reachable")
		})
	}
	wg.Wait()
	close(stop)
	<-sampled

	t.Logf("threads: idle %d, peak %d (budget %d)", idle, peak.Load(), threadBudget)
	assert.Less(t, int(peak.Load()), threadBudget)
	assert.Zero(t, writer.Dropped(), "the queue was sized for one refresh's rows")
}
