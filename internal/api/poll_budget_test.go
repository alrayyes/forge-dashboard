package api_test

import "time"

// pollBudget bounds a require.Eventually over a read that can itself block.
// GET /api/dashboard, /api/main-branches, the forge API stats and an MCP tool
// call all hold for the first background refresh (up to the server's 15s
// first-load wait), and one call runs several hundred milliseconds under
// parallel -race load. A budget of one or two seconds therefore fails on the
// call's latency, not on a missing condition. A satisfied poll returns at
// once, so a generous bound costs a passing run nothing.
//
// Polls that only read atomics, counters or a non-blocking endpoint such as
// GET /api/settings keep their short literal: nothing there waits.
const pollBudget = 30 * time.Second
