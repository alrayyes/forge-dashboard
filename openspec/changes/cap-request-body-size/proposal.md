# Proposal

## Why

Every JSON endpoint decoded its request body with no limit, so a client could send a body of any size. Ticketed as [alrayyes/forge-dashboard#1008](https://github.com/alrayyes/forge-dashboard/issues/1008) from the OWASP API4 finding in [alrayyes/forge-dashboard#879](https://github.com/alrayyes/forge-dashboard/issues/879).

## What Changes

- A request body is capped at 1 MiB at the mux. A declared length over it is answered 413 before the handler reads; a chunked body is cut off at the cap.
- The forges' webhook routes keep their own 5 MiB cap.
- Every request field carries a bound in the spec (`maxLength`, `maximum`; no request has a list but the opaque ones), and a value over it is a 400 with a field error. Spectral's `request-*-limit` rules hold the spec to it.

## Capabilities

### New Capabilities

- `api-limits`: how large a request the API accepts.
