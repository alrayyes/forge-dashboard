package oauth

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// maxRepoPages bounds the walk through one installation's repositories: 100
// pages of 100 is far past what one account grants the App.
const maxRepoPages = 100

// InstallationRepos lists the repositories the connected user can read through
// installation id (GET /user/installations/{id}/repositories), as lower-case
// owner/name. It is how a read with the installation's token is narrowed to
// what the user could see themselves (#4576). ErrNotConnected means no account
// is linked.
func (g *GitHub) InstallationRepos(ctx context.Context, id int64) (map[string]struct{}, error) {
	bearer, ok := g.Bearer(ctx)
	if !ok {
		return nil, ErrNotConnected
	}

	out := map[string]struct{}{}

	for page := 1; page <= maxRepoPages; page++ {
		// Fetched per page: a token that expires mid-walk is renewed, and one
		// disconnected mid-walk stops the walk.
		token, err := bearer()
		if err != nil {
			return nil, fmt.Errorf("%w: no usable token", ErrAccount)
		}

		names, err := g.installationReposPage(ctx, token, id, page)
		if err != nil {
			return nil, err
		}

		for _, n := range names {
			out[strings.ToLower(n)] = struct{}{}
		}

		if len(names) < installationsPerPage {
			break
		}
	}

	return out, nil
}

func (g *GitHub) installationReposPage(ctx context.Context, token string, id int64, page int) ([]string, error) {
	ctx, cancel := context.WithTimeout(ctx, accountTimeout)
	defer cancel()

	url := fmt.Sprintf("%s/user/installations/%d/repositories?per_page=%d&page=%d", g.urls.API, id, installationsPerPage, page)

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
		Repositories []struct {
			FullName string `json:"full_name"`
		} `json:"repositories"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxRepoBody)).Decode(&body); err != nil {
		return nil, fmt.Errorf("%w: unexpected answer", ErrAccount)
	}

	names := make([]string, 0, len(body.Repositories))
	for _, r := range body.Repositories {
		names = append(names, r.FullName)
	}

	return names, nil
}

// maxRepoBody bounds one page of repositories, which are far larger than an
// account read.
const maxRepoBody = 16 << 20
