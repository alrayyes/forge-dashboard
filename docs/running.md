# Running it

```sh
go build -o forge-dashboard ./cmd/forge-dashboard
mkdir -p data
export ENCRYPTION_KEY="$(openssl rand -base64 32)"   # once; keep it for later runs
DB_PATH=./data/forge-dashboard.db ./forge-dashboard
```

Then open `http://localhost:8080`, register a passkey — `RP_ID`/
`RP_ORIGIN` default to `localhost`/`http://localhost:8080`, which matches
this local run with nothing extra to set — and add your GitHub/Forgejo
credentials from the Settings page.

## Docker

The `/data` directory the image ships is where the database goes — mount
a volume there, or every passkey and every saved credential is gone the
moment the container is recreated:

```sh
docker build -t forge-dashboard .
export ENCRYPTION_KEY="$(openssl rand -base64 32)"   # once; keep it for later runs
docker run --rm -p 8080:8080 \
  --cap-drop=ALL --security-opt=no-new-privileges --read-only \
  --memory=64m --cpus=0.5 --pids-limit=64 \
  -v forge-dashboard-data:/data \
  -e RP_ID=localhost -e RP_ORIGIN=http://localhost:8080 \
  -e ENCRYPTION_KEY \
  forge-dashboard
```

The image carries a `HEALTHCHECK` that runs `/forge-dashboard healthcheck`,
which asks `GET /readyz`. It means "can serve": the database answers and its
tables exist. Once someone has signed in and a first dashboard refresh has
finished, it also waits on that, and a forge that failed the refresh still
counts. A freshly started container has no refresh to wait for, since the
app only fetches from the forges after a sign-in. The database ping gets 2
seconds and its result is reused for about 3, so a stuck database answers
503 instead of hanging the probe. On SIGTERM it answers 503 at once, then
the server waits `SHUTDOWN_DRAIN` before it stops. A 200 also reports the
`goroutines` and OS `threads` the process holds. The container's process limit
counts threads, so watch `threads` to see growth before the healthcheck can no
longer start. A 50-repo refresh from six tabs peaks at about 20 threads, so
`--pids-limit=64` leaves room. Read it with:

```sh
docker inspect --format '{{.State.Health.Status}}' <container>
```

`starting` is normal for up to 30 seconds after boot, then `healthy`. A
healthy container stays healthy when a forge goes unreachable. That shows
on the dashboard, not here. `GET /healthz` stays the cheap liveness answer
(the process is up). In Compose, `depends_on` with
`condition: service_healthy` waits on the same state.

Generate `ENCRYPTION_KEY` once and keep it — losing it makes every saved
credential unrecoverable, and every user has to re-enter theirs from the
Settings page.

The published image is `ghcr.io/alrayyes/forge-dashboard`, built and
pushed on every release by `.goreleaser.yml`'s `dockers:` block — tagged
by version and `:latest`, `linux/amd64` and `linux/arm64`.

## Before you upgrade

An instance has one owner. The first start after upgrading from a version that
allowed several users keeps the oldest user who has a passkey and deletes every
other user, once. Their sessions, API tokens, passkeys, saved credentials,
settings, hidden pull requests, queued actions, request-log rows, outstanding
invites and shares go with them. A database with a single user, or none, loses
nothing.

Copy the database before you upgrade. Copy `DB_PATH` together with its `-wal`
and `-shm` files, with the server stopped, so the copy is complete.

The server also copies the database itself before it deletes anything, next to
the original, as `<DB_PATH>.before-single-user-<UTC timestamp>`. If that copy
cannot be written, nothing is deleted, the log says so, and the next start
tries again. Delete the backup once you are satisfied; the server never does.

The log has one `single-user cleanup: removed user` warning per deleted user and
a summary line. A table named `single_user_cleanup` records that the cleanup ran,
so later starts leave the database alone. Whoever finishes the first passkey
registration on an empty instance becomes its owner, so register yours as soon
as a new instance is up.
