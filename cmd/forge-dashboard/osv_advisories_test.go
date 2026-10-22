package main

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestNewAdvisoryScanner_OffUnlessSwitchedOn(t *testing.T) {
	t.Parallel()

	assert.Nil(t, newAdvisoryScanner(""), "off by default: lockfile contents go to a third party")
	assert.Nil(t, newAdvisoryScanner("off"))
	assert.Nil(t, newAdvisoryScanner("yes please"))
	assert.NotNil(t, newAdvisoryScanner("on"))
	assert.NotNil(t, newAdvisoryScanner(" ON "))
	assert.NotNil(t, newAdvisoryScanner("true"))
	assert.NotNil(t, newAdvisoryScanner("1"))
}
