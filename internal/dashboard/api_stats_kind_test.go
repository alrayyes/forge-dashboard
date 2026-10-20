package dashboard_test

import (
	"context"
	"sync"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/apistats"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
)

// kindRecordingSource notes the apistats kind and repo each fetch arrives
// under, which is what the counting transport reads from the same context.
type kindRecordingSource struct {
	*fakeRepoRefresherSource

	mu        sync.Mutex
	fullKinds []apistats.Kind
	repoKinds []apistats.Kind
}

func (s *kindRecordingSource) Fetch(ctx context.Context) dashboard.Result {
	s.mu.Lock()
	s.fullKinds = append(s.fullKinds, apistats.KindFrom(ctx))
	s.mu.Unlock()

	return s.fakeRepoRefresherSource.Fetch(ctx)
}

func (s *kindRecordingSource) FetchRepo(ctx context.Context, owner, name, fullName string) ([]dashboard.PullRequest, []dashboard.Issue, error) {
	s.mu.Lock()
	s.repoKinds = append(s.repoKinds, apistats.KindFrom(ctx))
	s.mu.Unlock()

	return s.fakeRepoRefresherSource.FetchRepo(ctx, owner, name, fullName)
}

func newKindRecordingSource(prs ...dashboard.PullRequest) *kindRecordingSource {
	inner := newFakeRepoRefresherSource()
	inner.setRepo("alrayyes/a", prs)

	return &kindRecordingSource{fakeRepoRefresherSource: inner}
}

type hookKindClient struct {
	fakeWebhookCheckerClient

	mu   sync.Mutex
	kind apistats.Kind
}

func (c *hookKindClient) HasWebhook(ctx context.Context, owner, name string) (bool, error) {
	c.mu.Lock()
	c.kind = apistats.KindFrom(ctx)
	c.mu.Unlock()

	return c.fakeWebhookCheckerClient.HasWebhook(ctx, owner, name)
}

func TestAPIStats_AWebhookCheckInsideAFullRefreshIsTaggedHookMaintenance(t *testing.T) {
	t.Parallel()

	client := &hookKindClient{}
	client.repos = []dashboard.RepoRef{{FullName: "alrayyes/a", Owner: "alrayyes", Name: "a"}}
	source := dashboard.NewGenericSource(dashboard.ForgeForgejo, client, 4)

	source.Fetch(apistats.WithKind(t.Context(), apistats.KindFull))

	assert.Equal(t, apistats.KindHookMaintenance, client.kind)
}

func TestAPIStats_AFullRefreshIsTaggedFull(t *testing.T) {
	t.Parallel()

	src := newKindRecordingSource()
	agg := dashboard.NewAggregator([]dashboard.Source{src})

	agg.Refresh(t.Context())

	assert.Equal(t, []apistats.Kind{apistats.KindFull}, src.fullKinds)
}

func TestAPIStats_AWebhookScopedRefreshIsTaggedScopedWebhook(t *testing.T) {
	t.Parallel()

	src := newKindRecordingSource()
	agg := dashboard.NewAggregator([]dashboard.Source{src})

	agg.RefreshRepo(t.Context(), dashboard.ForgeGitHub, "alrayyes", "a", "alrayyes/a")

	assert.Equal(t, []apistats.Kind{apistats.KindScopedWebhook}, src.repoKinds)
}

func TestAPIStats_APollOfPendingCIIsTaggedCIPoll(t *testing.T) {
	t.Parallel()

	src := newKindRecordingSource(dashboard.PullRequest{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 1, CI: dashboard.CIPending})
	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.Refresh(t.Context())

	agg.PollCI(t.Context())

	assert.Equal(t, []apistats.Kind{apistats.KindCIPoll}, src.repoKinds)
}

func TestAPIStats_APollOfAnArmedAutoMergeIsTaggedAutoMergePoll(t *testing.T) {
	t.Parallel()

	on := true
	src := newKindRecordingSource(dashboard.PullRequest{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 1, CI: dashboard.CISuccess, AutoMergeEnabled: &on})
	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.Refresh(t.Context())

	agg.PollCI(t.Context())

	assert.Equal(t, []apistats.Kind{apistats.KindAutoMergePoll}, src.repoKinds)
}
