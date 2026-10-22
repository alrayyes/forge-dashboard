package main

// This file is package main, not main_test, on purpose: it tests unexported
// functions of the program itself, and another package can't import package
// main. Anything that can live in a library package is tested there instead
// (rules/go-test.md prefers the external test package).

import (
	"bytes"
	"fmt"
	"log/slog"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestResolveRefreshInterval_NoEnv_UsesDefault pins the raised default
// (#381): five minutes was sized around polling being the only way an
// update ever arrived, which stopped being true once every tracked repo
// got a real webhook — a reconciliation poll this frequent spends most of
// its GraphQL budget confirming nothing changed.
func TestResolveRefreshInterval_NoEnv_UsesDefault(t *testing.T) {
	got := resolveRefreshInterval("")
	assert.Equal(t, defaultRefreshInterval, got)
}

func TestResolveRefreshInterval_ValidEnv_Overrides(t *testing.T) {
	got := resolveRefreshInterval("2m30s")
	assert.Equal(t, 2*time.Minute+30*time.Second, got)
}

func TestResolveRefreshInterval_InvalidEnv_FallsBackToDefault(t *testing.T) {
	got := resolveRefreshInterval("not-a-duration")
	assert.Equal(t, defaultRefreshInterval, got)
}

// A zero or negative refresh interval is meaningless (zero would give the
// loop no wait at all), so it falls back to the default and says so.
func TestResolveRefreshInterval_ZeroOrNegative_FallsBackToDefaultAndLogsTheValue(t *testing.T) {
	for _, v := range []string{"0s", "0", "-5m", "-1ns"} {
		t.Run(v, func(t *testing.T) {
			logs := captureLog(t)
			assert.Equal(t, defaultRefreshInterval, resolveRefreshInterval(v))
			assert.Contains(t, logs.String(), "REFRESH_INTERVAL")
			assert.Contains(t, logs.String(), "value="+v)
		})
	}
}

// captureLog swaps the default logger for one that writes to a buffer, so a
// test can assert the line an operator would see.
func captureLog(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, nil)))
	t.Cleanup(func() { slog.SetDefault(prev) })

	return &buf
}

// A positive interval under the minimum asked for "faster", so it is raised to
// the minimum, not thrown away for the 20 minute default. 30s must not turn
// into 20m.
func TestResolveRefreshInterval_BelowMinimum_ClampsToMinimumAndLogsTheValue(t *testing.T) {
	for _, v := range []string{"30s", "1ms", "1ns", "59s"} {
		t.Run(v, func(t *testing.T) {
			logs := captureLog(t)
			assert.Equal(t, minRefreshInterval, resolveRefreshInterval(v))
			assert.Contains(t, logs.String(), "level=ERROR")
			assert.Contains(t, logs.String(), "REFRESH_INTERVAL")
			assert.Contains(t, logs.String(), "value="+v)
		})
	}
}

func TestResolveRefreshInterval_Minimum_IsAccepted(t *testing.T) {
	assert.Equal(t, minRefreshInterval, resolveRefreshInterval("1m"))
}

// A negative poll interval is a typo, not the way to turn the poll off ("0s"
// is), so it falls back to the default and says so.
func TestResolveCIPollInterval_Negative_FallsBackToDefaultAndLogsTheValue(t *testing.T) {
	logs := captureLog(t)
	assert.Equal(t, defaultCIPollInterval, resolveCIPollInterval("-5m"))
	assert.Contains(t, logs.String(), "level=ERROR")
	assert.Contains(t, logs.String(), "CI_POLL_INTERVAL")
	assert.Contains(t, logs.String(), "value=-5m")
}

// Below the floor the poll is raised to it, like REFRESH_INTERVAL, and 0s
// still means off.
func TestResolveCIPollInterval_BelowMinimum_ClampsToMinimumAndLogsTheValue(t *testing.T) {
	for _, v := range []string{"1ms", "9s"} {
		t.Run(v, func(t *testing.T) {
			logs := captureLog(t)
			assert.Equal(t, minCIPollInterval, resolveCIPollInterval(v))
			assert.Contains(t, logs.String(), "CI_POLL_INTERVAL")
			assert.Contains(t, logs.String(), "value="+v)
		})
	}
}

func TestResolveCIPollInterval_Minimum_IsAccepted(t *testing.T) {
	assert.Equal(t, minCIPollInterval, resolveCIPollInterval("10s"))
}

func TestResolveCIPollInterval_ExplicitZero_DoesNotLog(t *testing.T) {
	logs := captureLog(t)
	assert.Equal(t, time.Duration(0), resolveCIPollInterval("0s"))
	assert.Empty(t, logs.String())
}

// TestResolveCIPollInterval_NoEnv_UsesDefault pins the CI-poll
// fallback's own default (#177): real Forgejo instances (confirmed
// live, twice independently, against two separate instances) silently
// drop the "status" webhook event even though the hook create/edit
// call reports success, so a finished check there waits out the full
// REFRESH_INTERVAL (20 minutes by default) before the dashboard
// reflects it without this.
func TestResolveCIPollInterval_NoEnv_UsesDefault(t *testing.T) {
	got := resolveCIPollInterval("")
	assert.Equal(t, defaultCIPollInterval, got)
}

func TestResolveCIPollInterval_ValidEnv_Overrides(t *testing.T) {
	got := resolveCIPollInterval("30s")
	assert.Equal(t, 30*time.Second, got)
}

func TestResolveCIPollInterval_InvalidEnv_FallsBackToDefault(t *testing.T) {
	got := resolveCIPollInterval("not-a-duration")
	assert.Equal(t, defaultCIPollInterval, got)
}

// An operator can explicitly turn the poll off — SetCIPollInterval
// treats zero as "disabled," and "0s" parses to a real zero duration
// rather than falling back to the default, so this is a real opt-out
// path, not an error case.
func TestResolveCIPollInterval_ExplicitZero_DisablesRatherThanFallingBack(t *testing.T) {
	got := resolveCIPollInterval("0s")
	assert.Equal(t, time.Duration(0), got)
}

func TestResolveIdleAfter_NoEnv_UsesDefault(t *testing.T) {
	got := resolveIdleAfter("")
	assert.Equal(t, dashboard.DefaultIdleAfter, got)
}

func TestResolveIdleAfter_ValidEnv_Overrides(t *testing.T) {
	got := resolveIdleAfter("5m")
	assert.Equal(t, 5*time.Minute, got)
}

// "0s" turns idle mode off: the refresh runs on its schedule whoever is there.
func TestResolveIdleAfter_ExplicitZero_DisablesRatherThanFallingBack(t *testing.T) {
	got := resolveIdleAfter("0s")
	assert.Equal(t, time.Duration(0), got)
}

// Every interval setting follows one policy: a value that cannot be used is
// logged and replaced by the default, and never stops the process.
func TestResolveIdleAfter_Bad_FallsBackToDefaultAndLogsTheValue(t *testing.T) {
	// "15" is the likely typo: a number with no unit is not a duration.
	for _, v := range []string{"soon", "15", "-5m"} {
		t.Run(v, func(t *testing.T) {
			logs := captureLog(t)
			assert.Equal(t, dashboard.DefaultIdleAfter, resolveIdleAfter(v))
			assert.Contains(t, logs.String(), "level=ERROR")
			assert.Contains(t, logs.String(), "IDLE_AFTER")
			assert.Contains(t, logs.String(), "value="+v)
		})
	}
}

func TestResolveShutdownDrain_Bad_LogsTheValue(t *testing.T) {
	for _, v := range []string{"soon", "-1s"} {
		t.Run(v, func(t *testing.T) {
			logs := captureLog(t)
			assert.Equal(t, defaultShutdownDrain, resolveShutdownDrain(v))
			assert.Contains(t, logs.String(), "level=ERROR")
			assert.Contains(t, logs.String(), "SHUTDOWN_DRAIN")
			assert.Contains(t, logs.String(), "value="+v)
			assert.NotContains(t, logs.String(), "error=<nil>")
		})
	}
}

// TestOpenDatabase_SurvivesConcurrentWriters is a regression test for
// forge-dashboard#82: without a busy_timeout, SQLite fails a write
// immediately with SQLITE_BUSY the moment another connection holds the
// write lock, instead of waiting for it — and database/sql routinely
// hands out more than one connection to concurrent goroutines.
func TestOpenDatabase_SurvivesConcurrentWriters(t *testing.T) {
	t.Setenv("DB_PATH", filepath.Join(t.TempDir(), "concurrency.db"))

	db, err := openDatabase()
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })

	_, err = db.ExecContext(t.Context(), `CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)`)
	require.NoError(t, err)

	const writers = 40
	var wg sync.WaitGroup
	errs := make(chan error, writers)
	for i := range writers {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, err := db.ExecContext(t.Context(), `INSERT INTO t (v) VALUES (?)`, fmt.Sprintf("row-%d", i))
			errs <- err
		}(i)
	}
	wg.Wait()
	close(errs)

	for err := range errs {
		//nolint:testifylint // deliberately assert, not require: every
		// concurrent writer's own result matters, not just the first —
		// require would stop the loop and hide how many actually failed.
		assert.NoError(t, err)
	}

	var count int
	require.NoError(t, db.QueryRowContext(t.Context(), `SELECT COUNT(*) FROM t`).Scan(&count))
	assert.Equal(t, writers, count)
}

// TestConfigureLogging_DebugLevel_EnablesDebugLogging is a regression test
// for a real incident: diagnosing a rate-limit burst needed to know the
// exact request volume it produced, and the process had no way to log at
// that detail at all. Not run in parallel — configureLogging mutates the
// global default logger, same as every other test in this package
// touching shared process state.
func TestConfigureLogging_DebugLevel_EnablesDebugLogging(t *testing.T) {
	t.Setenv("LOG_LEVEL", "debug")
	configureLogging()

	assert.True(t, slog.Default().Enabled(t.Context(), slog.LevelDebug))
}

func TestConfigureLogging_NoLevelSet_DebugStaysDisabled(t *testing.T) {
	t.Setenv("LOG_LEVEL", "")
	configureLogging()

	assert.False(t, slog.Default().Enabled(t.Context(), slog.LevelDebug))
	assert.True(t, slog.Default().Enabled(t.Context(), slog.LevelInfo))
}

// An explicit REFRESH_INTERVAL is the lower bound: the stretch while every
// webhook is healthy only ever lengthens it, even past the two hour cap.
func TestResolveRefreshInterval_Explicit_IsTheLowerBoundOfTheStretch(t *testing.T) {
	for _, v := range []string{"1m", "20m", "45m", "2h", "3h"} {
		got := resolveRefreshInterval(v)
		assert.GreaterOrEqual(t, dashboard.StretchedInterval(got), got, v)
	}
	assert.Equal(t, 3*time.Hour, dashboard.StretchedInterval(resolveRefreshInterval("3h")))
}
