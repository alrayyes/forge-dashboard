package oauth

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/settings"
	"golang.org/x/oauth2"
)

// githubForge is the key of GitHub's row in the token store.
const githubForge = "github"

// GitHubURLs are the two hosts GitHub's OAuth uses: web for the consent page
// and token endpoint, API for the account read. Only a test changes them.
type GitHubURLs struct {
	Web string
	API string
}

var realGitHub = GitHubURLs{Web: "https://github.com", API: "https://api.github.com"}

// GitHub links the owner's GitHub account with the dashboard's GitHub App,
// through its user-to-server OAuth flow (#3951). User tokens expire and the
// refresh token rotates on every use, so the pair is saved before it is used,
// and one source per process spends each refresh token once. The token is for
// the user's identity and what the user can see. Installation tokens stay the
// credential for reads where an installation exists.
type GitHub struct {
	ctx   context.Context //nolint:containedctx // the process's context, for refresh calls that outlive a request.
	cfg   oauth2.Config
	flow  *Flow
	store TokenStore
	urls  GitHubURLs

	// mu guards the fields below and every write to the store, so a refresh
	// that was already running can't save its pair after Disconnect.
	mu     sync.Mutex
	gen    int
	source *Source
}

// NewGitHub builds the connection for the GitHub App's client id and secret,
// with redirectURL as its callback URL. A blank id or secret makes Configured
// false.
func NewGitHub(ctx context.Context, clientID, clientSecret, redirectURL string, store TokenStore) *GitHub {
	return NewGitHubAt(ctx, clientID, clientSecret, redirectURL, store, realGitHub)
}

// NewGitHubAt is NewGitHub against other hosts, for a test.
func NewGitHubAt(ctx context.Context, clientID, clientSecret, redirectURL string, store TokenStore, urls GitHubURLs) *GitHub {
	cfg := oauth2.Config{
		ClientID:     clientID,
		ClientSecret: clientSecret,
		RedirectURL:  redirectURL,
		Endpoint: oauth2.Endpoint{
			AuthURL:   urls.Web + "/login/oauth/authorize",
			TokenURL:  urls.Web + "/login/oauth/access_token",
			AuthStyle: oauth2.AuthStyleInParams,
		},
	}

	return &GitHub{ctx: ctx, cfg: cfg, flow: NewFlow(cfg, attemptTTL, time.Now), store: store, urls: urls}
}

// Configured reports whether this server has a GitHub App client to sign in
// with. It is safe on a nil *GitHub.
func (g *GitHub) Configured() bool {
	return g != nil && g.cfg.ClientID != "" && g.cfg.ClientSecret != ""
}

// Begin starts a sign-in and returns the consent page URL. No scope is sent: a
// GitHub App's user token is limited by the App's own permissions.
func (g *GitHub) Begin() string {
	return g.flow.Begin()
}

// Finish completes the sign-in the browser returns from. It checks the state
// and PKCE verifier, exchanges the code, reads the account's login, and only
// then stores the pair. On any error nothing has been stored.
func (g *GitHub) Finish(ctx context.Context, state, code string) (login string, err error) {
	token, err := g.flow.Complete(ctx, state, code)
	if err != nil {
		return "", err
	}

	login, err = g.readAccount(ctx, token.AccessToken)
	if err != nil {
		return "", err
	}

	g.mu.Lock()
	defer g.mu.Unlock()

	g.gen++
	g.source = nil

	if err := g.store.SaveOAuthToken(ctx, githubForge, g.urls.Web, token); err != nil {
		return "", fmt.Errorf("oauth: store token: %w", err)
	}

	return login, nil
}

// ErrNotRevoked is what Disconnect returns when it deleted the local pair but
// GitHub did not confirm the revocation, so the grant may still be live there.
var ErrNotRevoked = errors.New("oauth: the forge did not revoke the grant")

// Disconnect asks GitHub to revoke the grant, then deletes the token pair. A
// refresh already under way can no longer save its result. If GitHub can't be
// reached or refuses, the pair is deleted all the same and the error wraps
// ErrNotRevoked. Nothing is retried.
func (g *GitHub) Disconnect(ctx context.Context) error {
	revokeErr := g.revoke(ctx)

	g.mu.Lock()
	defer g.mu.Unlock()

	g.gen++
	g.source = nil

	if err := g.store.DeleteOAuthToken(ctx, githubForge); err != nil {
		return fmt.Errorf("oauth: delete token: %w", err)
	}

	return revokeErr
}

// revoke deletes the App's grant for the linked user (DELETE
// /applications/{client_id}/grant), which ends the access token and its
// refresh token. It is a no-op when nothing is linked. The error never carries
// a token or the client secret.
func (g *GitHub) revoke(ctx context.Context) error {
	bearer, linked := g.Bearer(ctx)
	if !linked {
		return nil
	}

	accessToken, err := bearer()
	if err != nil {
		return fmt.Errorf("%w: no usable token", ErrNotRevoked)
	}

	ctx, cancel := context.WithTimeout(ctx, accountTimeout)
	defer cancel()

	payload, err := json.Marshal(map[string]string{"access_token": accessToken})
	if err != nil {
		return fmt.Errorf("%w: build request", ErrNotRevoked)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodDelete,
		g.urls.API+"/applications/"+url.PathEscape(g.cfg.ClientID)+"/grant", bytes.NewReader(payload))
	if err != nil {
		return fmt.Errorf("%w: build request", ErrNotRevoked)
	}

	req.SetBasicAuth(g.cfg.ClientID, g.cfg.ClientSecret)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("Content-Type", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("%w: request failed", ErrNotRevoked)
	}

	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusNoContent {
		return fmt.Errorf("%w: status %d", ErrNotRevoked, resp.StatusCode)
	}

	return nil
}

// Bearer returns a function that yields a current user access token,
// refreshing it when it has expired, and whether an account is linked at all.
func (g *GitHub) Bearer(ctx context.Context) (func() (string, error), bool) {
	if g == nil {
		return nil, false
	}

	g.mu.Lock()
	defer g.mu.Unlock()

	if g.source == nil {
		grantedBy, stored, err := g.store.OAuthToken(ctx, githubForge)
		if errors.Is(err, settings.ErrNotFound) {
			return nil, false
		}

		if err != nil {
			return func() (string, error) { return "", fmt.Errorf("oauth: read stored token: %w", err) }, true
		}

		// The pair belongs to the host that granted it. Nothing of it goes
		// anywhere else, not the access token and not, on a refresh, the secret.
		if strings.TrimSuffix(grantedBy, "/") != g.urls.Web {
			return nil, false
		}

		g.source = NewSource(g.ctx, g.cfg, stored, githubSaver{g: g, gen: g.gen})
	}

	source := g.source

	return func() (string, error) {
		tok, err := source.Token()
		if err != nil {
			return "", err
		}

		return tok.AccessToken, nil
	}, true
}

// githubSaver saves a refreshed pair only while the connection it was made for
// is still the current one.
type githubSaver struct {
	g   *GitHub
	gen int
}

func (s githubSaver) Save(ctx context.Context, token *oauth2.Token) error {
	s.g.mu.Lock()
	defer s.g.mu.Unlock()

	if s.g.gen != s.gen {
		return errDisconnected
	}

	if err := s.g.store.SaveOAuthToken(ctx, githubForge, s.g.urls.Web, token); err != nil {
		return fmt.Errorf("oauth: save token: %w", err)
	}

	return nil
}

// readAccount asks GitHub whose token this is. The token goes in a header,
// never in the URL, and no error here carries it.
func (g *GitHub) readAccount(ctx context.Context, accessToken string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, accountTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, g.urls.API+"/user", nil)
	if err != nil {
		return "", fmt.Errorf("%w: build request", ErrAccount)
	}

	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("Accept", "application/vnd.github+json")

	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("%w: request failed", ErrAccount)
	}

	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("%w: status %d", ErrAccount, resp.StatusCode)
	}

	var body struct {
		Login string `json:"login"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxAccountBody)).Decode(&body); err != nil || body.Login == "" {
		return "", fmt.Errorf("%w: unexpected answer", ErrAccount)
	}

	return body.Login, nil
}
