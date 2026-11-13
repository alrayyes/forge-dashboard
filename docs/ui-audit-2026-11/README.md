# UI audit, November 2026

Screens behind the UI audit tickets. `before-*` are real captures of this app
(light theme; 390px phone, 820px wide). `stitch/` are Google Stitch designs
from project `14084734886395562922` ("Forge Board UI Audit 2026-11"). Stitch
invents features and compliance claims, so each ticket records what was adopted
and what was rejected. The designs are a reference for layout, not a spec.

`before-label-wrap/` and `after-label-wrap/` show a 77-character label chip in
the pull request details dialog at 320px, on the CSS as it was and as it is
after the fix that wraps long label names.

`before-landscape/` and `after-landscape/` show the four list pages on a
phone held sideways, at 844×390 and 667×375, and before and after the chrome
folds up to leave room for a list row on the first screen.

`before-update-all-strip/` and `after-update-all-strip/` show the Update all
strip on the Pull requests page at 1280px and 390px, light and dark, before and
after the sentence and the listed chip are left out. The board header counts
the rows.

`before-nav-pill/` and `after-nav-pill/` show the navigation pills in the header
and on the phone tab bar, light and dark, before and after the total is left out
when it only repeats the one count beside it (2 running of 2 draws "2 running").

`before-forced-colors-toggles/` and `after-forced-colors-toggles/` show the
auto-merge segment (in the phone Filters sheet at 390px, inline at 1280px) and
the severity filters in the Dependency advisories dialog, cropped to the
control, with Chromium's forced colours emulation on. They show the fix that
gave a pressed segment button and a pressed advisories filter a thicker
border, so the pressed one is no longer told apart by colour alone.

The "after" side is current main. The "before" side is the same main build with
only the two forced-colours rules for `.segment button[aria-pressed="true"]`
and `.adv-filter[aria-pressed="true"]` deleted, so nothing else differs. These
are emulation shots: Chromium doesn't repaint system colours the way Windows
High Contrast does, so they show the non-colour mark, not the real palette.
Pause live updates has no shot: it is no longer an `aria-pressed` button, and
swaps its label between Pause and Resume, which forced colours keep.

`before-pill-count/` and `after-pill-count/` show the Main branches filter bar
(`All 2` active) at 390px, 820px and 1280px, light and dark, on the code before
and after the active pill's count was made readable (ticket 3317). In light the
count went from 4.04:1 (white at .85 opacity on `#0e7c86`) to 6.4:1 (opaque
white on `#0c6972`); dark is unchanged.

Stitch designs for moving the bulk actions into the card header (ticket 3755):

- `stitch/bulk-actions-header-desktop-1280.png`: Update all as an outlined
  button in the header's right-hand group, between the live control and the
  count, nothing under the header.
- `stitch/bulk-actions-header-phone-390-two-actions.png`: Update all and
  Rerun failed checks as two stacked full-width 44px outlined buttons under
  the live control and count row.
- `stitch/bulk-actions-header-phone-390-one-action.png`: the same header with
  Update all only.
- `stitch/bulk-actions-header-in-progress-desktop-1280.png`: the in-progress
  label "Updating 2 of 4" in the same slot (the slot is a little wider than
  in the idle design; build it at the idle width).
- `stitch/bulk-actions-dialog-desktop-1280.png`: the confirmation dialog with
  the scope in its title, "Update 2 pull requests?".
