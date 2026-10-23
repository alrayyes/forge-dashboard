package dashboard_test

import (
	"context"
	"fmt"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type fakeIssueActionsClient struct {
	fakeForgeClient
	calls []string
}

func (f *fakeIssueActionsClient) CloseIssue(_ context.Context, owner, name string, number int) error {
	f.calls = append(f.calls, fmt.Sprintf("close %s/%s#%d", owner, name, number))

	return nil
}

func (f *fakeIssueActionsClient) ReopenIssue(_ context.Context, owner, name string, number int) error {
	f.calls = append(f.calls, fmt.Sprintf("reopen %s/%s#%d", owner, name, number))

	return nil
}

func (f *fakeIssueActionsClient) CommentIssue(_ context.Context, owner, name string, number int, body string) error {
	f.calls = append(f.calls, fmt.Sprintf("comment %s/%s#%d %q", owner, name, number, body))

	return nil
}

func TestGenericSource_IssueActions_DelegateToClient(t *testing.T) {
	t.Parallel()

	client := &fakeIssueActionsClient{}
	source := dashboard.NewGenericSource(dashboard.ForgeForgejo, client, 4)

	require.NoError(t, source.CommentIssue(t.Context(), "homelab", "vps-docker", 12, "Done."))
	require.NoError(t, source.CloseIssue(t.Context(), "homelab", "vps-docker", 12))
	require.NoError(t, source.ReopenIssue(t.Context(), "homelab", "vps-docker", 12))

	assert.Equal(t, []string{
		`comment homelab/vps-docker#12 "Done."`,
		"close homelab/vps-docker#12",
		"reopen homelab/vps-docker#12",
	}, client.calls)
}

func TestGenericSource_IssueActions_ClientWithoutSupport_ReturnsError(t *testing.T) {
	t.Parallel()

	source := dashboard.NewGenericSource(dashboard.ForgeForgejo, &fakeForgeClient{}, 4)

	require.Error(t, source.CloseIssue(t.Context(), "homelab", "vps-docker", 12))
	require.Error(t, source.ReopenIssue(t.Context(), "homelab", "vps-docker", 12))
	require.Error(t, source.CommentIssue(t.Context(), "homelab", "vps-docker", 12, "x"))
}
