package forgejo

import (
	"fmt"
	"net/http"
)

// bearerPlaceholder stands in for a token the Client doesn't hold. It makes the
// Client act as an authenticated one (ListRepos, the raw requests); the
// transport below replaces the header it produces. It is not a credential.
const bearerPlaceholder = "oauth"

// SetBearerSource makes every request carry the access token src returns,
// asked for per request so a refresh reaches the very next call. Use it for an
// OAuth connection, whose access token expires in about an hour. A src error
// stops the request before it is sent. Call it right after construction and
// before SetStats, which wraps the transport this installs.
func (c *Client) SetBearerSource(src func() (string, error)) {
	c.token = bearerPlaceholder
	c.rawTransport = bearerTransport{base: c.rawTransport, src: src}
	c.httpClient.Transport = c.rawTransport
}

type bearerTransport struct {
	base http.RoundTripper
	src  func() (string, error)
}

func (t bearerTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	token, err := t.src()
	if err != nil {
		return nil, fmt.Errorf("forgejo: access token: %w", err)
	}

	// A RoundTripper must not change the request it was given.
	req = req.Clone(req.Context())
	req.Header.Set("Authorization", "Bearer "+token)

	return t.base.RoundTrip(req)
}
