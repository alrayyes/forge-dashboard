# The SvelteKit frontend (web/) builds to plain static files that
# //go:embed reads at Go compile time — this has to run and land in
# internal/api/static before the Go build stage below, not after.
# scripts/sync-web-build.sh does the merge; see its own header comment
# for why it's a merge and not a directory replace.
FROM oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61 AS web-build

WORKDIR /src

COPY package.json bun.lock bunfig.toml ./
COPY web/package.json web/
RUN bun install --frozen-lockfile --ignore-scripts

COPY web/ web/
COPY scripts/sync-web-build.sh scripts/changelog-json.ts scripts/
# The changelog page is built from this at build time (#813).
COPY CHANGELOG.md ./
COPY internal/api/static/ internal/api/static/
RUN bun run --filter web build && ./scripts/sync-web-build.sh

# Multi-stage: compile in a full toolchain image, copy only the binary into
# the runtime stage. Distroless because the build is static — there's no libc
# to bring along, and nothing left in the image to exec into if it's ever
# reached from outside.
FROM golang:1.27.1-bookworm@sha256:69a7b9788769bec032d238959b61854e9ae87f57be9029ec04e9885fabf99195 AS build

WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

COPY . .
# Overwrite with the real build — the COPY above already has this
# directory's hand-written pages, plus whatever stale merge output a
# previous local build left there; web-build's output is the source of
# truth for anything Svelte owns.
COPY --from=web-build /src/internal/api/static/ internal/api/static/

# Static, so the distroless base below is enough. -trimpath keeps build
# machine paths out of the binary.
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/forge-dashboard ./cmd/forge-dashboard

# A throwaway stage purely to mkdir — distroless below has no shell to do
# it in, and this is the only content this stage ever produces.
FROM busybox:1.38.0@sha256:dc2d74b28e4cf8984fa52af1f39bc7c3d9c73760b41a74d629f5d11b1ab28616 AS data-dir
RUN mkdir -p /data

FROM gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab

COPY --from=build /out/forge-dashboard /forge-dashboard
# Docker seeds a freshly created named volume from the image directory it's
# mounted over, ownership included — this is what lets a volume at /data
# come up already writable by nonroot, with no separate chown step needed
# at first run. The auth database (passkeys, sessions) lives here.
COPY --from=data-dir --chown=nonroot:nonroot /data /data

# The :nonroot base image variant already sets the user, so this is explicit
# rather than load-bearing — a project stamped from this template that swaps
# the base image keeps the guarantee anyway.
USER nonroot:nonroot

EXPOSE 8080

# Exec form, not shell form - distroless has no shell to interpret one. The
# binary's own "healthcheck" argument (checked first thing in main, before
# any of the real startup) exists for exactly this: nothing else in this
# image (no curl, no wget) could otherwise probe the server. It asks
# /readyz (database answers, first dashboard refresh done or 30 seconds
# gone), not /healthz: Docker keeps one health state, and Compose's
# service_healthy and the deploy pipeline read it as "can serve". The
# refresh wait is bounded so a slow forge can't keep a serving container
# unready. --start-period is failure-free time for a cold volume and the
# schema setup; the first refresh only starts once someone signs in, so a
# restarted container is ready on the database alone.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["/forge-dashboard", "healthcheck"]

ENTRYPOINT ["/forge-dashboard"]
