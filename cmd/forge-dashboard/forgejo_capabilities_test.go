package main

import (
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/forgejo"
	"github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// capabilityGap reports an optional capability the Forgejo client has but the
// Source the app registers for it lacks. The API asks the Source, not the
// client, so a forwarder missing from GenericSource answers 400 "doesn't
// support" in production while every API test passes against a fake Source
// (#455, #564, #1347, #1351).
func capabilityGap[T any](name string, client, source any) string {
	_, clientHas := client.(T)
	_, sourceHas := source.(T)
	if clientHas && !sourceHas {
		return name
	}

	return ""
}

func TestForgejoSource_ExposesEveryCapabilityItsClientHas(t *testing.T) {
	t.Parallel()

	creds := settings.Credentials{ForgejoURL: "https://forge.example", ForgejoToken: "t"}
	sources := buildSourcesForUser(newTestAuthStore(t), nil, 0, nil)([]byte("user"), creds)
	require.Len(t, sources, 1)
	source := sources[0]
	require.Equal(t, dashboard.ForgeForgejo, source.Forge())
	client := forgejo.NewClient(creds.ForgejoURL, creds.ForgejoToken, "")

	// Every optional capability the API or the aggregator asks a Source for,
	// except the ones that are GitHub-only by design: Dependabot commands and
	// GitHub auto-merge. A new one belongs here, so its missing forwarder fails
	// this test and not a Forgejo user.
	gaps := []string{
		capabilityGap[dashboard.WebhookManager]("WebhookManager", client, source),
		capabilityGap[dashboard.PullRequestMerger]("PullRequestMerger", client, source),
		capabilityGap[dashboard.PullRequestStateReader]("PullRequestStateReader", client, source),
		capabilityGap[dashboard.PullRequestCloser]("PullRequestCloser", client, source),
		capabilityGap[dashboard.ChecksRerunner]("ChecksRerunner", client, source),
		capabilityGap[dashboard.BranchUpdater]("BranchUpdater", client, source),
		capabilityGap[dashboard.PullRequestChecker]("PullRequestChecker", client, source),
		capabilityGap[dashboard.PullRequestLabeler]("PullRequestLabeler", client, source),
		capabilityGap[dashboard.PullRequestBodyEditor]("PullRequestBodyEditor", client, source),
	}

	var missing []string
	for _, gap := range gaps {
		if gap != "" {
			missing = append(missing, gap)
		}
	}
	assert.Empty(t, missing, "the Forgejo client has these capabilities but its Source doesn't forward them")
}
