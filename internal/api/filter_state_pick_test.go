package api_test

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The Label, Repo and Author filters' picks are saved as lowercase labels separated by a newline.
// The save is refused when it is longer than a cookie should carry, or when a
// label holds a control character, which could split it into two picks.
func TestFilterStatePut_Pick(t *testing.T) {
	t.Parallel()

	for _, key := range []string{"label", "repo", "author"} {
		t.Run(key, func(t *testing.T) {
			t.Parallel()
			runPickCases(t, key)
		})
	}
}

func runPickCases(t *testing.T, key string) {
	t.Helper()

	labels := func(n int) string { return strings.TrimSuffix(strings.Repeat(`l\n`, n), `\n`) }
	cases := map[string]struct {
		pick string
		want int
	}{
		"one label":               {`bug`, http.StatusNoContent},
		"several labels":          {`bug\nsecurity`, http.StatusNoContent},
		"no label at all":         {``, http.StatusNoContent},
		"twenty labels":           {labels(20), http.StatusNoContent},
		"twenty-one labels":       {labels(21), http.StatusBadRequest},
		"a thousand characters":   {strings.Repeat("a", 1000), http.StatusNoContent},
		"over a thousand":         {strings.Repeat("a", 1001), http.StatusBadRequest},
		"a tab inside a label":    {`bug\tfix`, http.StatusBadRequest},
		"a carriage return":       {`bug\rfix`, http.StatusBadRequest},
		"a null character":        {`bug\u0000fix`, http.StatusBadRequest},
		"multibyte under the cap": {strings.Repeat("é", 1000), http.StatusNoContent},
		"multibyte over the cap":  {strings.Repeat("é", 1001), http.StatusBadRequest},
	}

	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			srv := newTestServer(t)
			sessionCookie, _, _ := registerViaRealCeremony(t, srv)
			body := `{"shared":{"` + key + `":"` + tc.pick + `"}}`

			resp := doJSON(t, http.MethodPut, srv.URL+"/api/v1/settings/filter-state", body, sessionCookie)
			defer func() { _ = resp.Body.Close() }()

			assert.Equal(t, tc.want, resp.StatusCode)

			if tc.want == http.StatusBadRequest {
				var out struct {
					Error string `json:"error"`
				}
				require.NoError(t, json.NewDecoder(resp.Body).Decode(&out))
				assert.Contains(t, out.Error, `"`+key+`"`, "the refusal names the filter that failed")
			}
		})
	}
}
