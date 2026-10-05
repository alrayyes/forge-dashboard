package main

// This file is package main, not main_test, on purpose: it tests unexported
// functions of the program itself, and another package can't import package
// main. Anything that can live in a library package is tested there instead
// (rules/go-test.md prefers the external test package).

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestDrainThenShutdown_FlipsUnreadyBeforeShutdownAndWaitsTheDelay(t *testing.T) {
	t.Parallel()

	var order []string
	start := time.Now()
	var waited time.Duration

	err := drainThenShutdown(30*time.Millisecond,
		func() { order = append(order, "drain") },
		func(context.Context) error {
			waited = time.Since(start)
			order = append(order, "shutdown")

			return nil
		})

	require.NoError(t, err)
	assert.Equal(t, []string{"drain", "shutdown"}, order)
	assert.GreaterOrEqual(t, waited, 30*time.Millisecond)
}

func TestResolveShutdownDrain_NoEnv_UsesDefault(t *testing.T) {
	t.Parallel()

	assert.Equal(t, defaultShutdownDrain, resolveShutdownDrain(""))
}

func TestResolveShutdownDrain_InvalidOrNegative_UsesDefault(t *testing.T) {
	t.Parallel()

	assert.Equal(t, defaultShutdownDrain, resolveShutdownDrain("soon"))
	assert.Equal(t, defaultShutdownDrain, resolveShutdownDrain("-1s"))
}

func TestResolveShutdownDrain_Zero_DisablesTheWait(t *testing.T) {
	t.Parallel()

	assert.Equal(t, time.Duration(0), resolveShutdownDrain("0s"))
}
