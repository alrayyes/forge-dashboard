package dashboard

import (
	"context"
	"time"
)

// CachedRepo is one repo's rows as the snapshot cache keeps them: the JSON of
// everything a refresh fetched for it, and when that was.
type CachedRepo struct {
	Repo      string
	FetchedAt time.Time
	Payload   []byte
}

// SnapshotCache keeps the last snapshot across restarts. Rows are keyed by
// forge, credential label and repo, never by user. The credential label is the
// one the API counters use and holds no secret.
type SnapshotCache interface {
	// LoadSnapshotRepos returns every repo stored for forge under credential.
	LoadSnapshotRepos(ctx context.Context, forge Forge, credential string) ([]CachedRepo, error)
	// SaveSnapshotChanges writes the repos in changed (replacing any stored row
	// of the same name) and deletes the ones named in removed, leaving every
	// other row stored for forge under credential as it is.
	SaveSnapshotChanges(ctx context.Context, forge Forge, credential string, changed []CachedRepo, removed []string) error
}

// SeenRecord is when a webhook delivery of one event class last arrived for a repo.
type SeenRecord struct {
	Repo  string
	Class EventClass
	At    time.Time
}

// WebhookSeenStore keeps the webhook_seen record across restarts, keyed by
// forge, credential label, repo and event class.
type WebhookSeenStore interface {
	LoadWebhookSeen(ctx context.Context, forge Forge, credential string) ([]SeenRecord, error)
	SaveWebhookSeen(ctx context.Context, forge Forge, credential string, rec SeenRecord) error
}

// HookCheck is what the last look at a repo's hooks found.
type HookCheck struct {
	Repo      string
	Has       bool
	Events    []string
	Refused   bool
	CheckedAt time.Time
}

// HookCheckStore keeps the webhook-check results across restarts, keyed by
// forge, credential label and repo.
type HookCheckStore interface {
	LoadHookChecks(ctx context.Context, forge Forge, credential string) ([]HookCheck, error)
	SaveHookCheck(ctx context.Context, forge Forge, credential string, check HookCheck) error
}
