package oauth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
)

// ErrNotConnected means no GitHub account is linked, so there is no user token
// to ask GitHub with.
var ErrNotConnected = errors.New("oauth: no GitHub account is connected")

// maxInstallationPages bounds the walk through GET /user/installations.
const maxInstallationPages = 10

// UserInstallation is one installation of the App that the connected user can
// access, as GitHub lists it.
type UserInstallation struct {
	ID           int64
	AccountLogin string
}

// UserInstallations lists the App's installations the connected user can
// access (GET /user/installations). It is how a redirect to the Setup URL is
// checked: an ID that isn't in this list is not stored (#4575).
func (g *GitHub) UserInstallations(ctx context.Context) ([]UserInstallation, error) {
	bearer, ok := g.Bearer(ctx)
	if !ok {
		return nil, ErrNotConnected
	}

	token, err := bearer()
	if err != nil {
		return nil, fmt.Errorf("%w: no usable token", ErrAccount)
	}

	var out []UserInstallation

	for page := 1; page <= maxInstallationPages; page++ {
		batch, err := g.installationsPage(ctx, token, page)
		if err != nil {
			return nil, err
		}

		out = append(out, batch...)

		if len(batch) < installationsPerPage {
			break
		}
	}

	return out, nil
}

const installationsPerPage = 100

func (g *GitHub) installationsPage(ctx context.Context, token string, page int) ([]UserInstallation, error) {
	ctx, cancel := context.WithTimeout(ctx, accountTimeout)
	defer cancel()

	url := fmt.Sprintf("%s/user/installations?per_page=%d&page=%d", g.urls.API, installationsPerPage, page)

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("%w: build request", ErrAccount)
	}

	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/vnd.github+json")

	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("%w: request failed", ErrAccount)
	}

	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%w: status %d", ErrAccount, resp.StatusCode)
	}

	var body struct {
		Installations []struct {
			ID      int64 `json:"id"`
			Account struct {
				Login string `json:"login"`
			} `json:"account"`
		} `json:"installations"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxAccountBody)).Decode(&body); err != nil {
		return nil, fmt.Errorf("%w: unexpected answer", ErrAccount)
	}

	out := make([]UserInstallation, 0, len(body.Installations))
	for _, in := range body.Installations {
		out = append(out, UserInstallation{ID: in.ID, AccountLogin: in.Account.Login})
	}

	return out, nil
}

// Account is the login of the linked account, asked of GitHub with the user
// token. ErrNotConnected means none is linked.
func (g *GitHub) Account(ctx context.Context) (string, error) {
	bearer, ok := g.Bearer(ctx)
	if !ok {
		return "", ErrNotConnected
	}

	token, err := bearer()
	if err != nil {
		return "", fmt.Errorf("%w: no usable token", ErrAccount)
	}

	return g.readAccount(ctx, token)
}

// Login is the linked account's login, or "" when none is linked or GitHub
// can't be asked. It is asked once and remembered until the account changes,
// so reading Settings doesn't spend the user's rate limit.
func (g *GitHub) Login(ctx context.Context) string {
	if g == nil {
		return ""
	}

	g.mu.Lock()
	known, gen := g.login, g.gen
	g.mu.Unlock()

	if known != "" {
		return known
	}

	login, err := g.Account(ctx)
	if err != nil {
		return ""
	}

	g.mu.Lock()
	defer g.mu.Unlock()

	if g.gen == gen {
		g.login = login
	}

	return login
}
