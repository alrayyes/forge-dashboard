package main

import (
	"bytes"
	"log/slog"
	"testing"

	"github.com/stretchr/testify/assert"
)

func scannerFor(setting string) (scanner any, logs string) {
	var buf bytes.Buffer
	s := newAdvisoryScanner(setting, slog.New(slog.NewTextHandler(&buf, nil)))
	if s == nil {
		return nil, buf.String()
	}

	return s, buf.String()
}

func TestNewAdvisoryScanner_OffUnlessSwitchedOn(t *testing.T) {
	t.Parallel()

	for _, off := range []string{"", "off", "false", "0", " OFF "} {
		s, logs := scannerFor(off)
		assert.Nil(t, s, "off by default: lockfile contents go to a third party")
		assert.NotContains(t, logs, "level=WARN", "%q is a clear no", off)
	}
	for _, on := range []string{"on", " ON ", "true", "1"} {
		s, _ := scannerFor(on)
		assert.NotNil(t, s, on)
	}
}

func TestNewAdvisoryScanner_AnUnrecognisedValueStaysOffAndSaysSo(t *testing.T) {
	t.Parallel()

	for _, value := range []string{"yes", "enabled", "yes please"} {
		s, logs := scannerFor(value)
		assert.Nil(t, s, value)
		assert.Contains(t, logs, "level=WARN", "an operator who typed %q meant on and should hear it is off", value)
		assert.Contains(t, logs, "OSV_ADVISORIES")
	}
}
