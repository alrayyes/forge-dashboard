package oauth

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"time"

	"golang.org/x/oauth2"
)

// httpTimeout bounds every call to the forge's OAuth endpoints.
const httpTimeout = 30 * time.Second

// client talks to a forge's token and account endpoints. It never follows a
// redirect: a token request carries the client secret, the code and the
// verifier in its body, and Go re-sends a 307 or 308 body to wherever it
// points. A redirect is returned as the answer, which fails the exchange.
var client = &http.Client{
	Timeout:       httpTimeout,
	CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
}

// withClient makes oauth2's token calls on ctx use client.
func withClient(ctx context.Context) context.Context {
	return context.WithValue(ctx, oauth2.HTTPClient, client)
}

// errorCode is what an OAuth error code looks like (RFC 6749 section 5.2).
var errorCode = regexp.MustCompile(`^[a-z_]{1,64}$`)

// redact reduces an error from a token request to its HTTP status and the
// standard error code. The body of an instance's answer can hold anything,
// including what was sent to it (a proxy or a hostile instance may echo the
// code, the client secret or the refresh token), so none of it is kept.
func redact(err error) string {
	if re, ok := errors.AsType[*oauth2.RetrieveError](err); ok {
		if re.ErrorCode != "" && errorCode.MatchString(re.ErrorCode) {
			return fmt.Sprintf("status %d, %s", re.Response.StatusCode, re.ErrorCode)
		}

		return fmt.Sprintf("status %d", re.Response.StatusCode)
	}

	// A transport error names the URL asked, which is the instance's own
	// address and holds no secret (the secret travels in the body).
	return "request failed"
}
