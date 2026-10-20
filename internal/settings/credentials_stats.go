package settings

import "github.com/alrayyes/forge-dashboard/internal/apistats"

// StatsCredentials lists the forge-API counter labels this user's credentials
// are counted under, so a request for the counters can show a user only the
// rows their own credentials made. A GitHub App installation and a token are
// both listed when both are saved, since which one a refresh uses depends on
// whether the server has the App configured.
func (c Credentials) StatsCredentials() []apistats.CredentialRef {
	var refs []apistats.CredentialRef
	if c.GitHubAppInstallationID != 0 {
		refs = append(refs, apistats.CredentialRef{Forge: "github", Credential: apistats.AppCredential(c.GitHubAppInstallationID)})
	}
	switch {
	case c.GitHubToken != "":
		refs = append(refs, apistats.CredentialRef{Forge: "github", Credential: apistats.TokenCredential(c.GitHubToken)})
	case c.GitHubUsername != "":
		refs = append(refs, apistats.CredentialRef{Forge: "github", Credential: apistats.AccountCredential(c.GitHubUsername)})
	}
	if c.ForgejoURL != "" {
		switch {
		case c.ForgejoToken != "":
			refs = append(refs, apistats.CredentialRef{Forge: "forgejo", Credential: apistats.TokenCredential(c.ForgejoToken)})
		case c.ForgejoUsername != "":
			refs = append(refs, apistats.CredentialRef{Forge: "forgejo", Credential: apistats.AccountCredential(c.ForgejoUsername)})
		}
	}

	return refs
}
