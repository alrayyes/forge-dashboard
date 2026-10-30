package api_test

import "time"

// pollBudget bounds a require.Eventually that waits for the first background
// refresh to land. GET /api/v1/dashboard and /api/v1/main-branches hold for that
// refresh (up to the server's 15s first-load wait) and an MCP tool call can
// too, and one call runs several hundred milliseconds under parallel -race
// load. A budget of one or two seconds therefore fails on the call's latency,
// not on a missing condition. GET /api/v1/settings does not block, but its
// ignored-title counts only appear once the refresh has landed, so those
// polls use it too. A satisfied poll returns at once, so a generous bound
// costs a passing run nothing.
//
// Polls that only read atomics, counters or logs keep their short literal:
// each read returns at once, so the poll costs only its own interval.
const pollBudget = 30 * time.Second
