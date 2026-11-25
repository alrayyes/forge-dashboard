package oauth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// ErrNotForgejo means nothing at the address answered like a Forgejo.
var ErrNotForgejo = errors.New("oauth: not a Forgejo instance")

// instanceTimeout is short on purpose: a person is waiting on the setup page.
const instanceTimeout = 8 * time.Second

// maxVersionBody caps what an address can make this read.
const maxVersionBody = 4 << 10

// CheckForgejoInstance asks instance for its public version, which every
// Forgejo answers without a login. It returns the address without a trailing
// slash. Redirects are not followed and nothing the instance says is returned.
func CheckForgejoInstance(ctx context.Context, instance string) (string, error) {
	instance = strings.TrimSuffix(instance, "/")

	ctx, cancel := context.WithTimeout(ctx, instanceTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, instance+"/api/v1/version", nil)
	if err != nil {
		return "", fmt.Errorf("%w: build request", ErrNotForgejo)
	}

	req.Header.Set("Accept", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("%w: no answer", ErrNotForgejo)
	}

	defer func() { _ = resp.Body.Close() }()

	var body struct {
		Version string `json:"version"`
	}

	if resp.StatusCode != http.StatusOK ||
		json.NewDecoder(io.LimitReader(resp.Body, maxVersionBody)).Decode(&body) != nil ||
		body.Version == "" {
		return "", fmt.Errorf("%w: unexpected answer", ErrNotForgejo)
	}

	return instance, nil
}
