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
		"node_modules/left-pad":{"version":"1.3.0","resolved":"https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz"},
		"node_modules/a/node_modules/@scope/b":{"version":"2.0.1","dev":true,"resolved":"https://registry.npmjs.org/@scope/b/-/b-2.0.1.tgz"},
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

	got, err := osv.ParsePackageLock([]byte(`{"packages":{"node_modules/my-lodash":{"name":"lodash","version":"4.17.0","resolved":"https://registry.npmjs.org/lodash/-/lodash-4.17.0.tgz"}}}`))
	require.NoError(t, err)
	assert.Equal(t, []osv.Package{{Ecosystem: "npm", Name: "lodash", Version: "4.17.0"}}, got)
}

func TestParsePackageLock_SkipsWhatDidNotComeFromTheRegistry(t *testing.T) {
	t.Parallel()

	lock := `{"packages":{
		"node_modules/reg":{"version":"1.0.0","resolved":"https://registry.npmjs.org/reg/-/reg-1.0.0.tgz"},
		"node_modules/private":{"version":"2.0.0","resolved":"https://npm.example.com/private/-/private-2.0.0.tgz"},
		"node_modules/mirror":{"version":"2.0.0","resolved":"https://registry.npmjs.org.evil.example/mirror/-/mirror-2.0.0.tgz"},
		"node_modules/gitdep":{"version":"1.0.0","resolved":"git+ssh://git@github.com/o/gitdep.git#abc"},
		"node_modules/tarball":{"version":"1.0.0","resolved":"https://example.com/tarball-1.0.0.tgz"},
		"node_modules/local":{"version":"1.0.0","resolved":"file:../local"},
		"node_modules/bundled":{"version":"1.0.0"},
		"node_modules/blank":{"version":"1.0.0","resolved":""}}}`

	got, err := osv.ParsePackageLock([]byte(lock))
	require.NoError(t, err)
	assert.ElementsMatch(t, []osv.Package{
		{Ecosystem: "npm", Name: "reg", Version: "1.0.0"},
	}, got, "only the public registry's packages are sent: a private registry's names stay home, as do git, tarball and file sources and entries with no resolved source")
}

func TestParsePackageLock_KeepsEntriesFromTheYarnRegistryHost(t *testing.T) {
	t.Parallel()

	lock := `{"packages":{"node_modules/y":{"version":"1.0.0","resolved":"https://registry.yarnpkg.com/y/-/y-1.0.0.tgz"}}}`

	got, err := osv.ParsePackageLock([]byte(lock))
	require.NoError(t, err)
	assert.Equal(t, []osv.Package{{Ecosystem: "npm", Name: "y", Version: "1.0.0"}}, got)
}

func TestParseGoMod_AnEmptyOrGarbageFileIsAnError(t *testing.T) {
	t.Parallel()

	for _, data := range []string{"", "\n\n", "<html>not a go.mod</html>", "require github.com/a/b v1.0.0\n"} {
		_, err := osv.ParseGoMod([]byte(data))
		require.Error(t, err, "%q has no module directive, so it is not a go.mod", data)
	}

	got, err := osv.ParseGoMod([]byte("module x\n\ngo 1.22\n"))
	require.NoError(t, err, "a module with no requirements is a real, empty go.mod")
	assert.Empty(t, got)
}

func TestParsePackageLock_NothingLeftAfterFilteringIsAnError(t *testing.T) {
	t.Parallel()

	lock := `{"packages":{"":{},
		"node_modules/a":{"version":"1.0.0","resolved":"https://npm.example.com/a/-/a-1.0.0.tgz"},
		"node_modules/b":{"version":"1.0.0","resolved":"git+ssh://git@example.com/o/b.git#abc"}}}`

	_, err := osv.ParsePackageLock([]byte(lock))
	require.ErrorIs(t, err, osv.ErrNoPublicPackages, "nothing was checked, so the repo must not read as a clean zero")

	got, err := osv.ParsePackageLock([]byte(`{"packages":{"":{}}}`))
	require.NoError(t, err, "a lock file with no dependencies at all is a real, empty one")
	assert.Empty(t, got)
}

func TestParseGoMod_ReadsQuotedPaths(t *testing.T) {
	t.Parallel()

	mod := "module \"example.com/x\"\n\n" +
		"require \"git.example.com/team/lib\" v1.0.0\n" +
		"require (\n\t\"github.com/a/b\" v1.2.3\n\t`github.com/c/d` v0.1.0\n)\n" +
		"replace \"github.com/c/d\" => \"github.com/e/f\" v0.2.0\n"

	got, err := osv.ParseGoMod([]byte(mod))
	require.NoError(t, err)
	assert.ElementsMatch(t, []osv.Package{
		{Ecosystem: "Go", Name: "git.example.com/team/lib", Version: "1.0.0"},
		{Ecosystem: "Go", Name: "github.com/a/b", Version: "1.2.3"},
		{Ecosystem: "Go", Name: "github.com/e/f", Version: "0.2.0"},
	}, got, "a quoted path is the same module, and quotes never reach OSV or the host match")
}

func TestParseGoMod_ACommentMarkerInsideAQuotedPathIsNotAComment(t *testing.T) {
	t.Parallel()

	mod := "module example.com/x\n" +
		"require \"example.com//odd\" v1.0.0 // indirect\n" +
		"require `example.com//raw` v2.0.0\n"

	got, err := osv.ParseGoMod([]byte(mod))
	require.NoError(t, err)
	assert.ElementsMatch(t, []osv.Package{
		{Ecosystem: "Go", Name: "example.com//odd", Version: "1.0.0"},
		{Ecosystem: "Go", Name: "example.com//raw", Version: "2.0.0"},
	}, got, "a comment starts at the first // outside quotes")
}
