package dbdsn_test

import (
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dbdsn"
	"github.com/stretchr/testify/assert"
)

func TestFor_AppendsTheBusyTimeoutAndWALOptions(t *testing.T) {
	t.Parallel()

	assert.Equal(t, "/data/forge-dashboard.db?_busy_timeout=5000&_journal_mode=WAL", dbdsn.For("/data/forge-dashboard.db"))
}
