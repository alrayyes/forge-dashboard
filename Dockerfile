# Multi-stage: compile in a full toolchain image, copy only the binary into
# the runtime stage. Distroless because the build is static — there's no libc
# to bring along, and nothing left in the image to exec into if it's ever
# reached from outside.
FROM golang:1.27.0-bookworm@sha256:ded31c68586d2e49e760acc2e65a884b23d032e9bbbed0ae0c55abd3fcaf4452 AS build

WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

COPY . .

# Static, so the distroless base below is enough. -trimpath keeps build
# machine paths out of the binary.
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/forge-dashboard ./cmd/forge-dashboard

FROM gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab

COPY --from=build /out/forge-dashboard /forge-dashboard

# The :nonroot base image variant already sets the user, so this is explicit
# rather than load-bearing — a project stamped from this template that swaps
# the base image keeps the guarantee anyway.
USER nonroot:nonroot

EXPOSE 8080

ENTRYPOINT ["/forge-dashboard"]
