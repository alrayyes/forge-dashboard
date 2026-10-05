# Proposal

## Why

The server grades each rate-limit budget, but three places in the web UI still ran their own thresholds: Insights' gauge (5% and 20%), the Webhooks lock (`remaining === 0`) and `isRateLimited`. A second client would grade differently. Ticketed as [alrayyes/forge-dashboard#979](https://github.com/alrayyes/forge-dashboard/issues/979), from the audit against `rules/frontend.md` (alrayyes/dotfiles#705), following [alrayyes/forge-dashboard#806](https://github.com/alrayyes/forge-dashboard/issues/806).

## What Changes

- `RateLimit.severity` gains `warning`: under 20% left but not yet low, the gauge's amber stage.
- Insights, Webhooks and `isRateLimited` read the server's grade and hold no cutoff.
- The banner stays quiet for `warning`.

## Capabilities

### Modified Capabilities

- `forge-error-display`: one rate-limit grade for every client.
