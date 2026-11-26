package hostname_test

import (
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/hostname"
	"github.com/stretchr/testify/assert"
)

func TestFold_LowersOnlyASCIILetters(t *testing.T) {
	t.Parallel()
	for in, want := range map[string]string{
		"Git.Example:443": "git.example:443",
		"İ.example":       "İ.example",
		"K.example":       "K.example",
		"É.Example":       "É.example",
		"":                "",
	} {
		assert.Equal(t, want, hostname.Fold(in), "%q", in)
	}
}

func TestEqual_IgnoresOnlyASCIICase(t *testing.T) {
	t.Parallel()
	assert.True(t, hostname.Equal("Git.Example", "git.example"))
	assert.False(t, hostname.Equal("K.example", "k.example"))
	assert.False(t, hostname.Equal("İ.example", "i.example"))
	assert.False(t, hostname.Equal("a.example", "b.example"))
}
