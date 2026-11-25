package oauth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/settings"
	"golang.org/x/oauth2"
)

// forgejoForge is the key of Forgejo's row in the token store.
const forgejoForge = "forgejo"

const (
	// attemptTTL is how long a started sign-in stays valid. Long enough to
	// log in to the forge and approve, short enough that an abandoned one is
	// useless.
	attemptTTL = 10 * time.Minute

	accountTimeout = 15 * time.Second
	maxAccountBody = 1 << 20
)

// ErrAccount means the instance granted a token but would not say whose it is.
var ErrAccount = errors.New("oauth: could not read the account name")

var errDisconnected = errors.New("oauth: the account was disconnected")

// TokenStore is where the token pair lives. settings.Store implements it.
type TokenStore interface {
	SaveOAuthToken(ctx context.Context, forge, instance string, token *oauth2.Token) error
	OAuthToken(ctx context.Context, forge string) (instance string, token *oauth2.Token, err error)
	DeleteOAuthToken(ctx context.Context, forge string) error
}

// ClientStore remembers the client id of a public client the owner registered
// on their own Forgejo, since a refresh has to name it. settings.Store
// implements it.
type ClientStore interface {
	SaveOAuthClientID(ctx context.Context, forge, clientID string) error
	OAuthClientID(ctx context.Context, forge string) (string, error)
	DeleteOAuthClientID(ctx context.Context, forge string) error
}

// ForgejoScopes are what the dashboard asks Forgejo for. A grant with no API
// scope is given all of them, so they are requested explicitly.
func ForgejoScopes() []string {
	return []string{"write:repository", "write:issue", "read:user"}
}

// Forgejo links one owner's Forgejo account with OAuth (#3951). It starts and
// finishes the sign-in, keeps the token pair in the store, and hands the
// Forgejo client a bearer token that refreshes itself. One Forgejo per
// process shares one refresh state, so a rebuilt client never spends a refresh
// token another already used.
type Forgejo struct {
	ctx   context.Context //nolint:containedctx // the process's context, for refresh calls that outlive a request.
	cfg   oauth2.Config
	flow  *Flow
	store TokenStore
	// clients holds a public client's id. Nil when only a server-configured
	// client is in use.
	clients ClientStore

	// mu guards the fields below, and every write to the store, so a refresh
	// that was already running can't save its pair after Disconnect deleted it.
	mu       sync.Mutex
	gen      int
	source   *Source
	instance string
}

// NewForgejo builds the connection for an OAuth client registered on the
// owner's Forgejo with redirectURL as its redirect URI. ctx is the process's
// own context. A blank client id or secret makes Configured false.
func NewForgejo(ctx context.Context, clientID, clientSecret, redirectURL string, store TokenStore) *Forgejo {
	cfg := oauth2.Config{ClientID: clientID, ClientSecret: clientSecret, RedirectURL: redirectURL}

	return &Forgejo{ctx: ctx, cfg: cfg, flow: NewFlow(cfg, attemptTTL, time.Now), store: store}
}

// UseClientStore turns on public clients: the owner names a Client ID on the
// setup page and it is kept here, with no secret, for refreshes.
func (f *Forgejo) UseClientStore(c ClientStore) {
	f.clients = c
}

// BeginPublic starts a sign-in with a public client the owner registered on
// instance, and returns the consent page URL. There is no secret.
func (f *Forgejo) BeginPublic(instance, clientID string) string {
	instance = strings.TrimSuffix(instance, "/")

	return f.flow.BeginAs(endpoint(instance), instance, clientID, ForgejoScopes())
}

// Configured reports whether this server has an OAuth client to sign in with.
// It is safe on a nil *Forgejo.
func (f *Forgejo) Configured() bool {
	return f != nil && f.cfg.ClientID != "" && f.cfg.ClientSecret != ""
}

// endpoint is Forgejo's own OAuth routes on instance. Credentials go in the
// form body: an authorization code is single use, so a first attempt in the
// wrong style that the instance answers with a failure would burn it.
func endpoint(instance string) oauth2.Endpoint {
	return oauth2.Endpoint{
		AuthURL:   instance + "/login/oauth/authorize",
		TokenURL:  instance + "/login/oauth/access_token",
		AuthStyle: oauth2.AuthStyleInParams,
	}
}

// Begin starts a sign-in against instance and returns the consent page URL.
func (f *Forgejo) Begin(instance string) string {
	instance = strings.TrimSuffix(instance, "/")

	return f.flow.BeginWith(endpoint(instance), instance)
}

// Finish completes the sign-in the browser returns from. It checks the state
// and PKCE verifier, exchanges the code, reads the account name, and only then
// stores the token pair. It returns the instance the attempt named and the
// account's login. On any error nothing has been stored.
func (f *Forgejo) Finish(ctx context.Context, state, code string) (instance, account string, err error) {
	token, instance, clientID, err := f.flow.complete(ctx, state, code)
	if err != nil {
		return "", "", err
	}

	account, err = readAccount(ctx, instance, token.AccessToken)
	if err != nil {
		return "", "", err
	}

	f.mu.Lock()
	defer f.mu.Unlock()

	f.gen++
	f.source = nil

	// A public client's id goes first: a token with no id could not refresh.
	if f.clients != nil && clientID != "" {
		if err := f.clients.SaveOAuthClientID(ctx, forgejoForge, clientID); err != nil {
			return "", "", fmt.Errorf("oauth: store client id: %w", err)
		}
	}

	if err := f.store.SaveOAuthToken(ctx, forgejoForge, instance, token); err != nil {
		return "", "", fmt.Errorf("oauth: store token: %w", err)
	}

	return instance, account, nil
}

// Disconnect deletes the token pair. A refresh already under way can no longer
// save its result.
func (f *Forgejo) Disconnect(ctx context.Context) error {
	f.mu.Lock()
	defer f.mu.Unlock()

	f.gen++
	f.source = nil

	if err := f.store.DeleteOAuthToken(ctx, forgejoForge); err != nil {
		return fmt.Errorf("oauth: delete token: %w", err)
	}

	if f.clients != nil {
		if err := f.clients.DeleteOAuthClientID(ctx, forgejoForge); err != nil {
			return fmt.Errorf("oauth: delete client id: %w", err)
		}
	}

	return nil
}

// Bearer returns a function that yields a current access token for instance,
// refreshing it when it has expired, and whether an account is linked at all.
func (f *Forgejo) Bearer(ctx context.Context, instance string) (func() (string, error), bool) {
	if f == nil {
		return nil, false
	}

	instance = strings.TrimSuffix(instance, "/")

	f.mu.Lock()
	defer f.mu.Unlock()

	if f.source == nil || f.instance != instance {
		linkedTo, stored, err := f.store.OAuthToken(ctx, forgejoForge)
		if errors.Is(err, settings.ErrNotFound) {
			return nil, false
		}

		if err != nil {
			// A read that failed is not "not linked": say so on every request
			// rather than quietly fall back to another credential.
			return func() (string, error) { return "", fmt.Errorf("oauth: read stored token: %w", err) }, true
		}

		// The pair belongs to the host that granted it. Asked for any other
		// address, say it isn't linked: nothing of it is sent there, not the
		// access token and not, on a refresh, the client secret.
		if strings.TrimSuffix(linkedTo, "/") != instance {
			f.source, f.instance = nil, ""

			return nil, false
		}

		cfg := f.refreshConfig(ctx, instance)
		f.source = NewSource(f.ctx, cfg, stored, guardedSaver{f: f, gen: f.gen, instance: instance})
		f.instance = instance
	}

	source := f.source

	return func() (string, error) {
		tok, err := source.Token()
		if err != nil {
			return "", err
		}

		return tok.AccessToken, nil
	}, true
}

// guardedSaver saves a refreshed pair only while the connection it was made
// for is still the current one.
type guardedSaver struct {
	f        *Forgejo
	gen      int
	instance string
}

func (g guardedSaver) Save(ctx context.Context, token *oauth2.Token) error {
	g.f.mu.Lock()
	defer g.f.mu.Unlock()

	if g.f.gen != g.gen {
		return errDisconnected
	}

	if err := g.f.store.SaveOAuthToken(ctx, forgejoForge, g.instance, token); err != nil {
		return fmt.Errorf("oauth: save token: %w", err)
	}

	return nil
}

// readAccount asks instance whose token this is. The token goes in a header,
// never in the URL, and no error here carries it.
func readAccount(ctx context.Context, instance, accessToken string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, accountTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, instance+"/api/v1/user", nil)
	if err != nil {
		return "", fmt.Errorf("%w: build request", ErrAccount)
	}

	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("Accept", "application/json")

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

// refreshConfig is the client config a refresh for instance runs under. A
// public client refreshes under its own id, with no secret.
func (f *Forgejo) refreshConfig(ctx context.Context, instance string) oauth2.Config {
	cfg := f.cfg
	cfg.Endpoint = endpoint(instance)

	if f.clients != nil {
		if id, err := f.clients.OAuthClientID(ctx, forgejoForge); err == nil && id != "" {
			cfg.ClientID, cfg.ClientSecret = id, ""
		}
	}

	return cfg
}
