# Deployment

The project's own instance runs on a homelab. The image is pulled into that
homelab's existing compose setup as its own service directory, routed through
the Traefik instance already running there. Passkey login is the access
control. That deployment config, including the `/data` volume and
`RP_ID`/`RP_ORIGIN` set to the real deployed domain rather than the
`localhost` defaults, lives in a private deployment repo, not here.
