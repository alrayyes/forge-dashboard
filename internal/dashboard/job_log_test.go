package dashboard_test

import (
	"strings"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
)

func TestNewJobLog_StripsColourCodesAndCarriageReturns(t *testing.T) {
	t.Parallel()

	got := dashboard.NewJobLog([]byte("\x1b[31mred\x1b[0m line\r\nnext\x1b[1;32m ok\x1b[0m\n"), false)

	assert.Equal(t, "red line\nnext ok\n", got.Text)
	assert.False(t, got.Truncated)
}

func TestNewJobLog_ReplacesInvalidUTF8(t *testing.T) {
	t.Parallel()

	got := dashboard.NewJobLog([]byte("ok \xff\xfe done"), false)

	assert.Equal(t, "ok  done", got.Text)
}

func TestNewJobLog_TooLarge_KeepsTheEndOnWholeLinesAndSaysSo(t *testing.T) {
	t.Parallel()

	var b strings.Builder
	for i := 0; b.Len() < 2*dashboard.MaxJobLogBytes; i++ {
		b.WriteString("line of output number that is long enough to count\n")
	}
	b.WriteString("the very last line\n")

	got := dashboard.NewJobLog([]byte(b.String()), false)

	assert.True(t, got.Truncated)
	assert.LessOrEqual(t, len(got.Text), dashboard.MaxJobLogBytes)
	assert.True(t, strings.HasSuffix(got.Text, "the very last line\n"))
	assert.True(t, strings.HasPrefix(got.Text, "line of output"), "starts on a whole line")
}

func TestNewJobLog_Empty(t *testing.T) {
	t.Parallel()

	got := dashboard.NewJobLog(nil, false)

	assert.Empty(t, got.Text)
	assert.False(t, got.Truncated)
}

func TestNewJobLog_AlreadyCut_DropsThePartialFirstLineAndSaysSo(t *testing.T) {
	t.Parallel()

	got := dashboard.NewJobLog([]byte("rt of a line\nwhole line\n"), true)

	assert.Equal(t, "whole line\n", got.Text)
	assert.True(t, got.Truncated)
}
