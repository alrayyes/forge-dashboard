package dashboard_test

import (
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
)

const renovateBodyHead = "This PR contains updates.\r\n\r\n---\r\n\r\n### Rebasing\r\n\r\n"

func TestTickRebaseCheckbox_UntickedBoxIsTickedAndNothingElseChanges(t *testing.T) {
	t.Parallel()

	tail := "\r\n\r\n---\r\n\r\n- [ ] foo\r\n"
	body := renovateBodyHead + "- [ ] <!-- rebase-check -->If you want to rebase/retry this PR, check this box" + tail

	got, state := dashboard.TickRebaseCheckbox(body)

	assert.Equal(t, dashboard.RebaseCheckboxUnticked, state)
	assert.Equal(t, renovateBodyHead+"- [x] <!-- rebase-check -->If you want to rebase/retry this PR, check this box"+tail, got)
}

func TestTickRebaseCheckbox_TickedBoxIsLeftAlone(t *testing.T) {
	t.Parallel()

	body := "- [x] <!-- rebase-check -->If you want to rebase/retry this PR, check this box"

	got, state := dashboard.TickRebaseCheckbox(body)

	assert.Equal(t, dashboard.RebaseCheckboxTicked, state)
	assert.Equal(t, body, got)
}

func TestTickRebaseCheckbox_CapitalXCountsAsTicked(t *testing.T) {
	t.Parallel()

	_, state := dashboard.TickRebaseCheckbox("- [X] <!-- rebase-check -->go")

	assert.Equal(t, dashboard.RebaseCheckboxTicked, state)
}

func TestTickRebaseCheckbox_NoCheckbox(t *testing.T) {
	t.Parallel()

	body := "- [ ] <!-- other-check -->not ours"

	got, state := dashboard.TickRebaseCheckbox(body)

	assert.Equal(t, dashboard.RebaseCheckboxAbsent, state)
	assert.Equal(t, body, got)
}

// RebaseCheckboxOf reads the box without changing the body, for a snapshot to
// say a rebase is already requested (#1349).
func TestRebaseCheckboxOf_ReadsTheStateWithoutTickingIt(t *testing.T) {
	t.Parallel()

	cases := map[string]struct {
		body string
		want dashboard.RebaseCheckbox
	}{
		"no box":   {"just a description", dashboard.RebaseCheckboxAbsent},
		"empty":    {"", dashboard.RebaseCheckboxAbsent},
		"unticked": {"- [ ] <!-- rebase-check -->If you want to rebase/retry this PR, check this box", dashboard.RebaseCheckboxUnticked},
		"ticked":   {"- [x] <!-- rebase-check -->If you want to rebase/retry this PR, check this box", dashboard.RebaseCheckboxTicked},
		"capital":  {"- [X] <!-- rebase-check -->go", dashboard.RebaseCheckboxTicked},
		"crlf":     {"a\r\n\r\n- [x] <!-- rebase-check -->go\r\n", dashboard.RebaseCheckboxTicked},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			assert.Equal(t, tc.want, dashboard.RebaseCheckboxOf(tc.body))
		})
	}
}
