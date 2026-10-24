package main

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestResolveAuthLimit_Enabled_AllowsABurstOfTenThenRefuses(t *testing.T) {
	t.Parallel()

	limiter, _, err := resolveAuthLimit("", true)

	require.NoError(t, err)
	require.NotNil(t, limiter)
	for range 10 {
		ok, _ := limiter.Allow("203.0.113.9")
		require.True(t, ok)
	}
	ok, wait := limiter.Allow("203.0.113.9")
	assert.False(t, ok)
	assert.InDelta(t, 6.0, wait.Seconds(), 0.5)
}

func TestResolveAuthLimit_Disabled_HasNoLimiter(t *testing.T) {
	t.Parallel()

	limiter, _, err := resolveAuthLimit("", false)

	require.NoError(t, err)
	assert.Nil(t, limiter)
}

func TestResolveAuthLimit_TrustedProxies_AreParsed(t *testing.T) {
	t.Parallel()

	_, proxies, err := resolveAuthLimit("192.0.2.0/24,203.0.113.5", true)

	require.NoError(t, err)
	assert.Len(t, proxies, 2)
}

func TestResolveAuthLimit_BadTrustedProxies_NamesTheSetting(t *testing.T) {
	t.Parallel()

	_, _, err := resolveAuthLimit("nonsense", true)

	require.Error(t, err)
	assert.Contains(t, err.Error(), "TRUSTED_PROXIES")
}
