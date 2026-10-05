package api_test

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/api"
	"github.com/stretchr/testify/require"
)

// A webhook delivery's body and signature come straight off the network, so
// the code that reads them must never panic and must hold its own promises
// whatever it is handed (#892). Seeds: real payload shapes and the edge cases
// that matter; testdata/fuzz holds more. Run one for longer with
// go test -fuzz=FuzzRepoFromPayload ./internal/api.

func FuzzRepoFromPayload(f *testing.F) {
	for _, seed := range []string{
		`{"repository":{"name":"a","full_name":"alrayyes/a","owner":{"login":"alrayyes"}}}`,
		`{"zen":"Keep it logically awesome.","hook_id":1}`, // GitHub's ping carries no repository
		`{"repository":null}`,
		`{"repository":{"owner":{"login":""},"name":"","full_name":""}}`,
		`{"repository":{"name":"a","full_name":"x/a","owner":{"login":"x"}}} trailing`,
		`[]`,
		`null`,
		``,
	} {
		f.Add([]byte(seed))
	}

	f.Fuzz(func(t *testing.T, body []byte) {
		owner, name, fullName, ok := api.RepoFromPayload(body)
		if !ok {
			require.Empty(t, owner+name+fullName, "a refused payload names no repository")

			return
		}
		require.NotEmpty(t, owner)
		require.NotEmpty(t, name)
		require.NotEmpty(t, fullName)

		// Reading is deterministic.
		owner2, name2, fullName2, ok2 := api.RepoFromPayload(body)
		require.True(t, ok2)
		require.Equal(t, [3]string{owner, name, fullName}, [3]string{owner2, name2, fullName2})
	})
}

func FuzzValidSignature(f *testing.F) {
	body := []byte(`{"zen":"hello"}`)
	mac := hmac.New(sha256.New, []byte("secret"))
	mac.Write(body)
	good := hex.EncodeToString(mac.Sum(nil))

	f.Add(body, "secret", good)
	f.Add(body, "secret", strings.ToUpper(good))
	f.Add(body, "secret", "")
	f.Add(body, "secret", "not hex")
	f.Add(body, "secret", good[:len(good)-2]) // one byte short
	f.Add([]byte{}, "", "")

	f.Fuzz(func(t *testing.T, body []byte, secret, signatureHex string) {
		mac := hmac.New(sha256.New, []byte(secret))
		mac.Write(body)
		want := hex.EncodeToString(mac.Sum(nil))

		got := api.ValidSignature(body, secret, signatureHex)

		// Accepted exactly when it is this body's HMAC, in either case of hex
		// digits. Anything else, malformed hex included, is refused and never
		// panics.
		require.Equal(t, strings.EqualFold(signatureHex, want), got)
	})
}

// The filter-state endpoint parses nothing of its own: it checks the body is
// well-formed JSON within a size cap and stores it. So the thing to hold is
// its contract for any body whatever: stored (204) exactly when the bytes are
// valid JSON no bigger than the cap, refused (400) otherwise, and never a 5xx.
func FuzzFilterStatePut(f *testing.F) {
	srv := newTestServer(f)
	cookie, _, _ := registerViaRealCeremony(f, srv, testUser, testDisplay)

	for _, seed := range []string{`{}`, `{"quick":"ready"}`, `[1,2,3]`, `"x"`, `null`, ``, `{`, `{"a":}`, "\xff\xfe"} {
		f.Add([]byte(seed))
	}

	f.Fuzz(func(t *testing.T, body []byte) {
		const capBytes = 16 * 1024

		resp := doJSON(t, http.MethodPut, srv.URL+"/api/settings/filter-state", string(body), cookie)
		_ = resp.Body.Close()

		want := http.StatusBadRequest
		if json.Valid(body) && len(body) <= capBytes {
			want = http.StatusNoContent
		}
		require.Equal(t, want, resp.StatusCode)
	})
}
