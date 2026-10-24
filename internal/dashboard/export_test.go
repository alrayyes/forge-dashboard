package dashboard

import "context"

// BackgroundForTest marks ctx the way the schedule does, so a test can run a
// refresh nobody asked for.
func BackgroundForTest(ctx context.Context) context.Context {
	return context.WithValue(ctx, backgroundKey{}, true)
}

// BoxOverrideCount is how many Renovate rebase box overrides the aggregator
// still holds.
func (a *Aggregator) BoxOverrideCount() int {
	a.botMu.Lock()
	defer a.botMu.Unlock()

	return len(a.boxOverrides)
}

// EndSentenceForTest exposes endSentence.
func EndSentenceForTest(msg string) string { return endSentence(msg) }
