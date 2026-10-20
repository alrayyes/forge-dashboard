package apistats

import (
	"crypto/sha256"
	"encoding/hex"
	"strconv"
)

// Credential labels name a credential in the counters without carrying a
// secret or a user id. Two users who connect the same account share a label,
// which is what a shared rate-limit budget needs.

// AppCredential labels a GitHub App installation.
func AppCredential(installationID int64) string {
	return "app:" + strconv.FormatInt(installationID, 10)
}

// TokenCredential labels a personal access token by a short hash of it. The
// hash can't be turned back into the token, and eight bytes keep two tokens
// from colliding in practice.
func TokenCredential(token string) string {
	sum := sha256.Sum256([]byte(token))

	return "token:" + hex.EncodeToString(sum[:8])
}

// AccountCredential labels unauthenticated access to a public account.
func AccountCredential(username string) string {
	return "public:" + username
}

// CredentialRef pairs a forge with one of its credential labels.
type CredentialRef struct {
	Forge      string
	Credential string
}
