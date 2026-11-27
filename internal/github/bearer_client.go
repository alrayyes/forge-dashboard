package github

import (
	"fmt"
	"net/http"
	"net/url"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/apistats"
	"github.com/alrayyes/forge-dashboard/internal/requestlog"
	ghsdk "github.com/google/go-github/v75/github"
)

// bearerTransport puts the source's current token on every request, so a token
// that expires or is revoked between two requests is never reused.
type bearerTransport struct {
	base   http.RoundTripper
	bearer func() (string, error)
}

func (t bearerTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	token, err := t.bearer()
	if err != nil {
		return nil, fmt.Errorf("github: no usable user token: %w", err)
	}

	clone := req.Clone(req.Context())
	clone.Header.Set("Authorization", "Bearer "+token)

	resp, err := t.base.RoundTrip(clone)
	if err != nil {
		return nil, fmt.Errorf("github: send request: %w", err)
	}

	return resp, nil
}

// NewBearerClient returns a Client that reads as a linked GitHub user (#4576).
// bearer yields a current user access token and is asked once per request.
// login names the account, for the cache and stats labels only. Like a
// personal-token Client it discovers every repo the user can push to.
func NewBearerClient(bearer func() (string, error), login, baseURL string, recorder ...requestlog.Recorder) *Client {
	if baseURL == "" {
		baseURL = defaultBaseURL
	}

	credential := apistats.AccountCredential("oauth:" + login)
	etag := newETagTransport(nil, credential)
	httpClient := &http.Client{Timeout: 30 * time.Second, Transport: bearerTransport{base: etag, bearer: bearer}}
	restClient := ghsdk.NewClient(httpClient)
	if u, err := url.Parse(baseURL + "/"); err == nil {
		restClient.BaseURL = u
	}

	rec := requestlog.Recorder(requestlog.NoopRecorder{})
	if len(recorder) > 0 && recorder[0] != nil {
		rec = recorder[0]
	}

	return &Client{
		httpClient:      httpClient,
		etag:            etag,
		baseURL:         baseURL,
		graphqlURL:      baseURL + "/graphql",
		restClient:      restClient,
		userAuth:        true,
		statsCredential: credential,
		recorder:        rec,

		renderedBodies: NewRenderedBodyCache(),
		advisories:     NewAdvisoryCache(),
		statusPresence: NewStatusPresenceCache(),
	}
}
