package dashboard_test

import (
	"reflect"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestCapabilitiesOf_EveryForgeAnswersEveryCapability(t *testing.T) {
	t.Parallel()

	tests := []struct {
		forge dashboard.Forge
		want  dashboard.ForgeCapabilities
	}{
		{dashboard.ForgeGitHub, dashboard.ForgeCapabilities{
			AutoMergeHeldByApp:         false,
			ChecksViaWebhook:           true,
			ServesRunningLog:           false,
			ServerLogExcerpts:          false,
			ApprovalGatedRuns:          true,
			DependabotCommands:         true,
			AdvisorySource:             "dependabot",
			AdvisoryUnknownNeedsReason: false,
			StatusPageURL:              "https://www.githubstatus.com/",
			RateLimitModel:             "graphql_and_rest",
			IssueRefSyntax:             "hash_or_gh_prefix",
			Label:                      "GitHub",
			BotLoginSuffix:             "[bot]",
			BotProfilePages:            map[string]string{"dependabot": "dependabot", "renovate": "apps/renovate"},
		}},
		{dashboard.ForgeForgejo, dashboard.ForgeCapabilities{
			AutoMergeHeldByApp:         true,
			ChecksViaWebhook:           false,
			ServesRunningLog:           true,
			ServerLogExcerpts:          true,
			ApprovalGatedRuns:          false,
			DependabotCommands:         false,
			AdvisorySource:             "osv",
			AdvisoryUnknownNeedsReason: true,
			StatusPageURL:              "",
			RateLimitModel:             "rest",
			IssueRefSyntax:             "hash",
			Label:                      "Forgejo",
		}},
	}

	for _, tc := range tests {
		t.Run(string(tc.forge), func(t *testing.T) {
			t.Parallel()

			got, ok := dashboard.CapabilitiesOf(tc.forge)
			require.True(t, ok)
			assert.Equal(t, tc.want, got)

			// Every text capability is filled in. The status page and the bot
			// suffix may be empty: the forge has no status page, or no bot accounts.
			v := reflect.ValueOf(got)
			for i := range v.NumField() {
				name := v.Type().Field(i).Name
				if v.Field(i).Kind() == reflect.String && name != "StatusPageURL" && name != "BotLoginSuffix" {
					assert.NotEmpty(t, v.Field(i).String(), name)
				}
			}
		})
	}
}

func TestCapabilitiesOf_UnknownForge(t *testing.T) {
	t.Parallel()

	_, ok := dashboard.CapabilitiesOf(dashboard.Forge("gitea"))
	assert.False(t, ok)
}

func TestWithCapabilities_FillsEachForgeAndLeavesTheInputAlone(t *testing.T) {
	t.Parallel()

	in := []dashboard.ForgeHealth{{Forge: dashboard.ForgeGitHub}, {Forge: dashboard.ForgeForgejo}}
	out := dashboard.WithCapabilities(in)

	assert.Equal(t, "GitHub", out[0].Capabilities.Label)
	assert.Equal(t, "Forgejo", out[1].Capabilities.Label)
	assert.Empty(t, in[0].Capabilities.Label)
}
