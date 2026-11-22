package settings

// Instance is the address and token of a self-hosted forge's own instance.
type Instance struct {
	URL   string
	Token string
}

// forgejoForge is the name Forgejo's saved fields answer to in InstanceFor.
const forgejoForge = "forgejo"

// InstanceFor returns the own-instance address and token saved for forge, and
// false when none is saved. Forgejo's come from its own fields; any other
// self-hosted forge is read from Instances, so a caller names the forge it is
// serving rather than a field (#4574).
func (c Credentials) InstanceFor(forge string) (Instance, bool) {
	in, ok := c.Instances[forge]
	if forge == forgejoForge {
		in, ok = Instance{URL: c.ForgejoURL, Token: c.ForgejoToken}, c.ForgejoURL != ""
	}

	return in, ok && in.URL != ""
}
