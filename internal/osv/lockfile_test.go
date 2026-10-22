package osv_test

import (
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/osv"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestParsePackageLock_ReadsEveryInstalledPackage(t *testing.T) {
	t.Parallel()

	lock := `{"lockfileVersion":3,"packages":{
		"":{"name":"app","version":"1.0.0"},
		"node_modules/left-pad":{"version":"1.3.0"},
		"node_modules/a/node_modules/@scope/b":{"version":"2.0.1","dev":true},
		"packages/local":{"version":"0.0.1"},
		"node_modules/linked":{"resolved":"packages/local","link":true}}}`

	got, err := osv.ParsePackageLock([]byte(lock))
	require.NoError(t, err)
	assert.ElementsMatch(t, []osv.Package{
		{Ecosystem: "npm", Name: "left-pad", Version: "1.3.0"},
		{Ecosystem: "npm", Name: "@scope/b", Version: "2.0.1"},
	}, got)
}

func TestParsePackageLock_RefusesWhatItCannotRead(t *testing.T) {
	t.Parallel()

	_, err := osv.ParsePackageLock([]byte(`{"lockfileVersion":1,"dependencies":{"a":{"version":"1.0.0"}}}`))
	require.Error(t, err, "a version 1 lockfile has no packages map; reading it as empty would be a false zero")

	_, err = osv.ParsePackageLock([]byte(`not json`))
	require.Error(t, err)
}

func TestParseGoMod_ReadsRequiredModules(t *testing.T) {
	t.Parallel()

	mod := `module example.com/app

go 1.25

require github.com/a/b v1.2.3

require (
	github.com/c/d v0.4.0 // indirect
	golang.org/x/text v0.0.0-20210101000000-abcdef123456
)

replace github.com/a/b => ../b
`
	got, err := osv.ParseGoMod([]byte(mod))
	require.NoError(t, err)
	assert.ElementsMatch(t, []osv.Package{
		{Ecosystem: "Go", Name: "github.com/a/b", Version: "1.2.3"},
		{Ecosystem: "Go", Name: "github.com/c/d", Version: "0.4.0"},
		{Ecosystem: "Go", Name: "golang.org/x/text", Version: "0.0.0-20210101000000-abcdef123456"},
	}, got)
}
