package api

import (
	"fmt"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

func TestSkippedAvatars_KeepsAtMostTheCapAndDropsTheOldest(t *testing.T) {
	t.Parallel()
	now := time.Unix(1000, 0)
	s := newSkippedAvatars(time.Hour, func() time.Time { return now })

	for i := range maxSkippedAvatarHosts + 3 {
		now = now.Add(time.Second)
		s.note(fmt.Sprintf("h%02d.example", i))
	}

	got := s.hosts("")
	assert.Len(t, got, maxSkippedAvatarHosts)
	assert.NotContains(t, got, "h00.example")
	assert.Contains(t, got, fmt.Sprintf("h%02d.example", maxSkippedAvatarHosts+2))
}

func TestSkippedAvatars_LeavesOutTheInstanceHostItself(t *testing.T) {
	t.Parallel()
	s := newSkippedAvatars(time.Hour, time.Now)
	s.note("git.example.com")
	s.note("gravatar.example")

	assert.Equal(t, []string{"gravatar.example"}, s.hosts("git.example.com"))
}

func TestSkippedAvatars_KeepsAHostAliveWhileItIsStillRefusedAndDropsItAfterTheTTL(t *testing.T) {
	t.Parallel()
	now := time.Unix(1000, 0)
	s := newSkippedAvatars(10*time.Minute, func() time.Time { return now })

	s.note("gravatar.example")
	now = now.Add(8 * time.Minute)
	s.note("gravatar.example")
	now = now.Add(8 * time.Minute)
	assert.Equal(t, []string{"gravatar.example"}, s.hosts(""))

	now = now.Add(3 * time.Minute)
	assert.Empty(t, s.hosts(""))
}
