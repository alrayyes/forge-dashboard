// Package settings is each user's own GitHub/Forgejo credentials — saved
// through the Settings page, encrypted at rest, and what
// dashboard.Manager builds that user's forge sources from. Replaces v1's
// GITHUB_TOKEN/FORGEJO_* environment variables, which configured one
// dashboard for everyone rather than one per signed-in user.
package settings

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
)

// ErrNoEncryptionKey is returned by NewCipher when key isn't valid
// AES-256 key material — a service holding real credentials has to fail
// loudly at startup rather than silently store them in the clear.
var ErrNoEncryptionKey = errors.New("settings: ENCRYPTION_KEY must decode to 32 bytes")

// Cipher encrypts and decrypts credential fields with AES-256-GCM.
type Cipher struct {
	gcm cipher.AEAD
}

// NewCipher builds a Cipher from base64Key, the raw form of
// ENCRYPTION_KEY. Generate one with `openssl rand -base64 32`.
func NewCipher(base64Key string) (*Cipher, error) {
	key, err := base64.StdEncoding.DecodeString(base64Key)
	if err != nil || len(key) != 32 {
		return nil, ErrNoEncryptionKey
	}

	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("settings: build AES cipher: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("settings: build GCM: %w", err)
	}
	return &Cipher{gcm: gcm}, nil
}

// Encrypt returns plaintext sealed under a fresh random nonce, both
// base64-encoded together so Decrypt needs nothing else to reverse it.
// An empty plaintext encrypts to an empty string — an unset credential
// field stays unset rather than becoming a real ciphertext of nothing.
func (c *Cipher) Encrypt(plaintext string) (string, error) {
	if plaintext == "" {
		return "", nil
	}

	nonce := make([]byte, c.gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", fmt.Errorf("settings: generate nonce: %w", err)
	}

	sealed := c.gcm.Seal(nonce, nonce, []byte(plaintext), nil)
	return base64.StdEncoding.EncodeToString(sealed), nil
}

// Decrypt reverses Encrypt. An empty input decrypts to an empty string.
func (c *Cipher) Decrypt(encoded string) (string, error) {
	if encoded == "" {
		return "", nil
	}

	sealed, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return "", fmt.Errorf("settings: decode ciphertext: %w", err)
	}

	nonceSize := c.gcm.NonceSize()
	if len(sealed) < nonceSize {
		return "", errors.New("settings: ciphertext too short")
	}
	nonce, ciphertext := sealed[:nonceSize], sealed[nonceSize:]

	plaintext, err := c.gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return "", fmt.Errorf("settings: decrypt: %w", err)
	}
	return string(plaintext), nil
}
