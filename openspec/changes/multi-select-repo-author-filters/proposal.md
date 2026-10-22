# Proposal

## Why

The Repo and Author filters took one value each, so a reviewer who watches two repos or follows three people had to switch the filter back and forth. The Label filter already takes several values and matches any of them; Repo and Author should work the same way, so all three read alike. The owner asked for it in [alrayyes/forge-dashboard#2538](https://github.com/alrayyes/forge-dashboard/issues/2538), together with each repo's logo and each author's avatar in the choices.

## What Changes

- Repo and Author become the same checkbox group Label is: a button that opens the choices, any of the ticked ones match, and the button names one pick or counts several.
- Each repo choice shows the repo's logo and each author choice their avatar, with an initial when there is none or it fails to load. The images are decorative and come from fields the dashboard already returns.
- A single repo or author saved before this reads back as a list of one.
- The server refuses a saved repo or author pick over the limits the label pick already has.
- Insights, which shares the filter state, shows the same controls.

## Capabilities

### Modified Capabilities

- `dashboard-filtering`: Repo and Author take several values and match any of them.
