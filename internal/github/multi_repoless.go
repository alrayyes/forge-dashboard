package github

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
)

// The calls below name no single repo, or name them all. The App's own status
// page, the Dependabot rule and the webhook's credential label are the same
// whichever installation answers, so the first member speaks for them.

// first is the first member as capability T, when there is one and it has it.
func first[T any](m *Multi) (T, bool) {
	var zero T
	if len(m.members) == 0 {
		return zero, false
	}
	t, ok := m.members[0].Source.(T)

	return t, ok
}

// CredentialLabel implements dashboard.CredentialLabeler. The webhook is the
// App's, not an installation's, so deliveries are tallied under one label.
func (m *Multi) CredentialLabel() string {
	if l, ok := first[dashboard.CredentialLabeler](m); ok {
		return l.CredentialLabel()
	}

	return ""
}

// DependabotCommandsBlockedReason implements dashboard.DependabotCommandBlocker.
func (m *Multi) DependabotCommandsBlockedReason() string {
	if b, ok := first[dashboard.DependabotCommandBlocker](m); ok {
		return b.DependabotCommandsBlockedReason()
	}

	return ""
}

// ProviderStatus implements dashboard.ProviderStatusSource.
func (m *Multi) ProviderStatus(ctx context.Context) *dashboard.ProviderStatus {
	if s, ok := first[dashboard.ProviderStatusSource](m); ok {
		return s.ProviderStatus(ctx)
	}

	return nil
}

// WebhookEvents implements dashboard.WebhookEventsReporter for owner/name.
func (m *Multi) WebhookEvents(fullName string) ([]string, bool) {
	owner, name, _ := strings.Cut(fullName, "/")
	if r, ok := m.Owner(owner, name).Source.(dashboard.WebhookEventsReporter); ok {
		return r.WebhookEvents(fullName)
	}

	return nil, false
}

// RefreshPending implements dashboard.PendingCheckRefresher. Each member is
// asked about its own repos only. A ref whose member cannot answer comes back
// in Failed, so the caller refreshes its repo on its own.
func (m *Multi) RefreshPending(ctx context.Context, refs []dashboard.PullRequestRef) (dashboard.PendingResult, error) {
	var (
		out     dashboard.PendingResult
		byOwner = map[int][]dashboard.PullRequestRef{}
		order   []int
	)
	for _, ref := range refs {
		i := m.ownerIndex(ref.Owner, ref.Name)
		if _, seen := byOwner[i]; !seen {
			order = append(order, i)
		}
		byOwner[i] = append(byOwner[i], ref)
	}

	var errs []error
	for _, i := range order {
		group := byOwner[i]
		if i >= len(m.members) {
			out.Failed = append(out.Failed, group...)

			continue
		}
		r, ok := m.members[i].Source.(dashboard.PendingCheckRefresher)
		if !ok {
			out.Failed = append(out.Failed, group...)

			continue
		}
		res, err := r.RefreshPending(ctx, group)
		out.Pulls = append(out.Pulls, res.Pulls...)
		out.Closed = append(out.Closed, res.Closed...)
		out.Failed = append(out.Failed, res.Failed...)
		if err != nil {
			errs = append(errs, fmt.Errorf("installation %d: refresh pending: %w", m.members[i].ID, err))
		}
	}

	return out, errors.Join(errs...)
}
