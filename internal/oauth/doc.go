// Package oauth runs the OAuth 2.0 authorization code flow with PKCE that links
// the owner's GitHub and Forgejo accounts to the dashboard (#3951). It follows
// RFC 9700: S256 PKCE on every request, an unguessable single-use state, and
// the exact redirect URI. It issues and checks attempts; storing the resulting
// tokens, encrypted, is the settings package's job.
package oauth
