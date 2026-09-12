package settings_test

import (
	"crypto/rand"
	"encoding/base64"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func randomKey(t *testing.T) string {
	t.Helper()
	key := make([]byte, 32)
	_, err := rand.Read(key)
	require.NoError(t, err)
	return base64.StdEncoding.EncodeToString(key)
}

func TestCipher_EncryptThenDecrypt_RoundTrips(t *testing.T) {
	t.Parallel()

	c, err := settings.NewCipher(randomKey(t))
	require.NoError(t, err)

	ciphertext, err := c.Encrypt("ghp_super-secret-token")
	require.NoError(t, err)
	assert.NotContains(t, ciphertext, "super-secret", "the ciphertext should not contain the plaintext")

	plaintext, err := c.Decrypt(ciphertext)
	require.NoError(t, err)
	assert.Equal(t, "ghp_super-secret-token", plaintext)
}

func TestCipher_EmptyPlaintext_RoundTripsToEmpty(t *testing.T) {
	t.Parallel()

	c, err := settings.NewCipher(randomKey(t))
	require.NoError(t, err)

	ciphertext, err := c.Encrypt("")
	require.NoError(t, err)
	assert.Empty(t, ciphertext)

	plaintext, err := c.Decrypt(ciphertext)
	require.NoError(t, err)
	assert.Empty(t, plaintext)
}

func TestCipher_SameValueEncryptedTwice_ProducesDifferentCiphertext(t *testing.T) {
	t.Parallel()

	c, err := settings.NewCipher(randomKey(t))
	require.NoError(t, err)

	first, err := c.Encrypt("same-token")
	require.NoError(t, err)
	second, err := c.Encrypt("same-token")
	require.NoError(t, err)

	assert.NotEqual(t, first, second, "a fresh random nonce each time should mean no two ciphertexts of the same value match")
}

func TestCipher_TamperedCiphertext_FailsToDecrypt(t *testing.T) {
	t.Parallel()

	c, err := settings.NewCipher(randomKey(t))
	require.NoError(t, err)

	ciphertext, err := c.Encrypt("a real token")
	require.NoError(t, err)

	raw, err := base64.StdEncoding.DecodeString(ciphertext)
	require.NoError(t, err)
	raw[len(raw)-1] ^= 0xFF // flip the last byte
	tampered := base64.StdEncoding.EncodeToString(raw)

	_, err = c.Decrypt(tampered)
	assert.Error(t, err, "GCM should refuse a ciphertext that was modified after sealing")
}

func TestNewCipher_WrongKeyLength_Errors(t *testing.T) {
	t.Parallel()

	_, err := settings.NewCipher(base64.StdEncoding.EncodeToString([]byte("too-short")))

	assert.ErrorIs(t, err, settings.ErrNoEncryptionKey)
}

func TestNewCipher_NotBase64_Errors(t *testing.T) {
	t.Parallel()

	_, err := settings.NewCipher("not valid base64!!!")

	assert.ErrorIs(t, err, settings.ErrNoEncryptionKey)
}
