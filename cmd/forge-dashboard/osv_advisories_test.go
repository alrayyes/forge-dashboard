package main

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestNewAdvisoryScanner_OnUnlessSwitchedOff(t *testing.T) {
	t.Parallel()

	assert.NotNil(t, newAdvisoryScanner(""), "on by default")
	assert.NotNil(t, newAdvisoryScanner("on"))
	assert.Nil(t, newAdvisoryScanner("off"))
	assert.Nil(t, newAdvisoryScanner(" OFF "))
	assert.Nil(t, newAdvisoryScanner("false"))
	assert.Nil(t, newAdvisoryScanner("0"))
}
