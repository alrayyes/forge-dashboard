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

replace github.com/c/d => ../d

replace (
	golang.org/x/text => golang.org/x/text v0.3.8
	github.com/a/b v1.2.3 => github.com/fork/b v1.2.4
)
`
	got, err := osv.ParseGoMod([]byte(mod))
	require.NoError(t, err)
	assert.ElementsMatch(t, []osv.Package{
		{Ecosystem: "Go", Name: "github.com/fork/b", Version: "1.2.4"},
		{Ecosystem: "Go", Name: "golang.org/x/text", Version: "0.3.8"},
	}, got, "a replace swaps the module that is built; a local path leaves nothing to match")
}

func TestParsePackageLock_AnAliasedInstallUsesTheRealName(t *testing.T) {
	t.Parallel()

	got, err := osv.ParsePackageLock([]byte(`{"packages":{"node_modules/my-lodash":{"name":"lodash","version":"4.17.0"}}}`))
	require.NoError(t, err)
	assert.Equal(t, []osv.Package{{Ecosystem: "npm", Name: "lodash", Version: "4.17.0"}}, got)
}

func TestParsePackageLock_SkipsWhatDidNotComeFromTheRegistry(t *testing.T) {
	t.Parallel()

	lock := `{"packages":{
		"node_modules/reg":{"version":"1.0.0","resolved":"https://registry.npmjs.org/reg/-/reg-1.0.0.tgz"},
		"node_modules/private":{"version":"2.0.0","resolved":"https://npm.example.com/private/-/private-2.0.0.tgz"},
		"node_modules/gitdep":{"version":"1.0.0","resolved":"git+ssh://git@github.com/o/gitdep.git#abc"},
		"node_modules/tarball":{"version":"1.0.0","resolved":"https://example.com/tarball-1.0.0.tgz"},
		"node_modules/local":{"version":"1.0.0","resolved":"file:../local"}}}`

	got, err := osv.ParsePackageLock([]byte(lock))
	require.NoError(t, err)
	assert.ElementsMatch(t, []osv.Package{
		{Ecosystem: "npm", Name: "reg", Version: "1.0.0"},
		{Ecosystem: "npm", Name: "private", Version: "2.0.0"},
	}, got, "a git, tarball or file source is not the registry package of that name")
}
