# Proposal

## Why

`AllowedActions` says what a pull request may do, but only the web page read it. The merge endpoint never checked it, so an SDK or CLI could merge a stacked, draft or empty pull request wherever the forge's own protection didn't stop it. Hiding a button is cosmetic; the server has to enforce. Ticketed as [alrayyes/forge-dashboard#978](https://github.com/alrayyes/forge-dashboard/issues/978), from the audit against `rules/frontend.md` (alrayyes/dotfiles#705).

## What Changes

- Merge answers 409 with the blocked entry's `code` and `message`, and never asks the forge, when the pull request is on the user's board and `AllowedActions` blocks Merge.
- A pull request the board doesn't hold is left to the forge, as before.
- Update branch, auto-merge and the bot actions follow in their own pull requests, one rule each.

## Capabilities

### Modified Capabilities

- `pr-merge-status`: the server enforces the allowed actions.
