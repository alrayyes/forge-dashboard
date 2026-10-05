package dashboard_test

import (
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
)

func TestIsHousekeepingIssue(t *testing.T) {
	t.Parallel()

	cases := []struct {
		title string
		want  bool
	}{
		{"Dependency Dashboard", true},
		{"  Dependency Dashboard  ", true},
		{"dependency dashboard", false},
		{"Fix the Dependency Dashboard link", false},
		{"Add a login page", false},
	}
	for _, tc := range cases {
		t.Run(tc.title, func(t *testing.T) {
			t.Parallel()

			assert.Equal(t, tc.want, dashboard.IsHousekeepingIssue(dashboard.Issue{Title: tc.title}))
		})
	}
}
