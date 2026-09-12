// Command forge-dashboard is the composition root: it builds a Source per
// configured forge, starts the aggregator's background refresh, and serves
// the API and static frontend against whatever the aggregator most
// recently assembled. See CLAUDE.md and the README for the environment
// variables that configure it.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/api"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/forgejo"
	"github.com/alrayyes/forge-dashboard/internal/github"
)

// version is stamped in at build time by goreleaser, from the tag. "dev" is
// what a plain `go build` reports, which is the honest answer for a binary
// built off an unknown tree.
var version = "dev"

const defaultRefreshInterval = 5 * time.Minute

func main() {
	addr := envOr("ADDR", ":8080")
	refreshInterval := defaultRefreshInterval
	if v := os.Getenv("REFRESH_INTERVAL"); v != "" {
		d, err := time.ParseDuration(v)
		if err != nil {
			slog.Error("invalid REFRESH_INTERVAL, using default", "value", v, "default", defaultRefreshInterval, "error", err)
		} else {
			refreshInterval = d
		}
	}

	sources := buildSources()
	agg := dashboard.NewAggregator(sources)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	go agg.Run(ctx, refreshInterval)

	srv := &http.Server{
		Addr:              addr,
		Handler:           api.NewMux(agg.Get),
		ReadHeaderTimeout: 5 * time.Second,
	}

	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			slog.Error("shutdown", "error", err)
		}
	}()

	slog.Info("starting", "version", version, "addr", addr, "sources", len(sources), "refreshInterval", refreshInterval)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		slog.Error("server stopped", "error", err)
		os.Exit(1)
	}
}

// buildSources wires one dashboard.Source per forge that has enough
// configuration to be worth trying. A forge with no token configured is
// skipped entirely rather than added and left to fail on every refresh —
// there's nothing useful to report about a forge nobody asked to watch.
func buildSources() []dashboard.Source {
	var sources []dashboard.Source

	if token := os.Getenv("GITHUB_TOKEN"); token != "" {
		client := github.NewClient(token, "")
		sources = append(sources, dashboard.NewGenericSource(dashboard.ForgeGitHub, client, dashboard.DefaultMaxConcurrency))
	} else {
		slog.Warn("GITHUB_TOKEN not set, skipping GitHub")
	}

	url, token := os.Getenv("FORGEJO_URL"), os.Getenv("FORGEJO_TOKEN")
	if url != "" && token != "" {
		client := forgejo.NewClient(url, token)
		sources = append(sources, dashboard.NewGenericSource(dashboard.ForgeForgejo, client, dashboard.DefaultMaxConcurrency))
	} else {
		slog.Warn("FORGEJO_URL or FORGEJO_TOKEN not set, skipping Forgejo")
	}

	return sources
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
