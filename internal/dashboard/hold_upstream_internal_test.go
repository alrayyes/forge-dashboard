package dashboard

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

const holdForge = Forge("holdForgejo")

func upstreamFailure() Result {
	return Result{Health: ForgeHealth{Forge: holdForge, ErrorKind: ForgeErrorUpstream, UpstreamStatus: 504}}
}

func heldFixture() (Snapshot, map[Forge]time.Time) {
	earlier := Snapshot{Forges: []ForgeHealth{{Forge: holdForge, Reachable: true}}}

	return earlier, map[Forge]time.Time{holdForge: time.Unix(1, 0)}
}

func TestHoldUpstreamErrorLeavesTheStreakAloneForAForgeNobodyAsked(t *testing.T) {
	earlier, goodAt := heldFixture()
	streaks := map[Forge]int{}

	for range 5 {
		_, held := holdUpstreamError(upstreamFailure(), false, earlier, goodAt, streaks, holdForge)
		assert.False(t, held)
	}

	assert.Zero(t, streaks[holdForge])

	held, ok := holdUpstreamError(upstreamFailure(), true, earlier, goodAt, streaks, holdForge)
	assert.True(t, ok, "the first real 504 is held")
	assert.True(t, held.Health.Reachable)
	assert.Equal(t, 1, streaks[holdForge])
}

func TestHoldUpstreamErrorLeavesTheStreakAloneForAReachableUnaskedAnswer(t *testing.T) {
	earlier, goodAt := heldFixture()
	streaks := map[Forge]int{holdForge: 2}

	holdUpstreamError(Result{Health: ForgeHealth{Forge: holdForge, Reachable: true}}, false, earlier, goodAt, streaks, holdForge)

	assert.Equal(t, 2, streaks[holdForge])
}

func TestHoldUpstreamErrorShowsTheBannerOnTheThirdRealFailure(t *testing.T) {
	earlier, goodAt := heldFixture()
	streaks := map[Forge]int{}

	for range ForgeFailureThreshold - 1 {
		_, ok := holdUpstreamError(upstreamFailure(), true, earlier, goodAt, streaks, holdForge)
		assert.True(t, ok)
	}
	_, ok := holdUpstreamError(upstreamFailure(), true, earlier, goodAt, streaks, holdForge)

	assert.False(t, ok)
}

func TestHoldUpstreamErrorResetsOnAnAskedReachableAnswer(t *testing.T) {
	earlier, goodAt := heldFixture()
	streaks := map[Forge]int{holdForge: 2}

	holdUpstreamError(Result{Health: ForgeHealth{Forge: holdForge, Reachable: true}}, true, earlier, goodAt, streaks, holdForge)

	assert.Zero(t, streaks[holdForge])
}
