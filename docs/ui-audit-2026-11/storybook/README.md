# Storybook stories and the Stitch audit

Generated from `bun run storybook:screenshots` (93 stories). Each story is
either audited by a numbered Stitch request (answers recorded below as they
arrive) or renders nothing in that state, so there is nothing to look at.
Sheets sent to Stitch are in `sheets/`. Audited at desktop 1280px, light theme
only: the catalogue has no phone or dark variants, so those remain covered only
by the route-level audit (forge-dashboard-1 to 27).

| Story                                                                            | Component                  | Stitch request                         | Outcome            |
| -------------------------------------------------------------------------------- | -------------------------- | -------------------------------------- | ------------------ |
| `advisoriesdialog--advisory-detail`                                              | `advisoriesdialog`         | forge-dashboard-28                     | audited, see below |
| `advisoriesdialog--closed`                                                       | `advisoriesdialog`         | forge-dashboard-28                     | audited, see below |
| `advisoriesdialog--detail-focus-on-back`                                         | `advisoriesdialog`         | forge-dashboard-28                     | audited, see below |
| `advisoriesdialog--empty`                                                        | `advisoriesdialog`         | forge-dashboard-28                     | audited, see below |
| `advisoriesdialog--filtered-to-critical`                                         | `advisoriesdialog`         | forge-dashboard-28                     | audited, see below |
| `advisoriesdialog--forgejo-list`                                                 | `advisoriesdialog`         | forge-dashboard-28                     | audited, see below |
| `advisoriesdialog--loading`                                                      | `advisoriesdialog`         | forge-dashboard-28                     | audited, see below |
| `advisoriesdialog--open-list`                                                    | `advisoriesdialog`         | forge-dashboard-28                     | audited, see below |
| `advisoriesdialog--partial-list`                                                 | `advisoriesdialog`         | forge-dashboard-29                     | audited, see below |
| `advisoriesdialog--request-failed`                                               | `advisoriesdialog`         | forge-dashboard-29                     | audited, see below |
| `advisoriesdialog--unreadable`                                                   | `advisoriesdialog`         | forge-dashboard-29                     | audited, see below |
| `checkrunoutput--closed`                                                         | `checkrunoutput`           | forge-dashboard-30                     | audited, see below |
| `checkrunoutput--expired`                                                        | `checkrunoutput`           | forge-dashboard-30                     | audited, see below |
| `checkrunoutput--forbidden`                                                      | `checkrunoutput`           | forge-dashboard-30                     | audited, see below |
| `checkrunoutput--loading`                                                        | `checkrunoutput`           | forge-dashboard-30                     | audited, see below |
| `checkrunoutput--no-output`                                                      | `checkrunoutput`           | forge-dashboard-30                     | audited, see below |
| `checkrunoutput--output-cut`                                                     | `checkrunoutput`           | forge-dashboard-30                     | audited, see below |
| `checkrunoutput--output-shown`                                                   | `checkrunoutput`           | forge-dashboard-30                     | audited, see below |
| `checkrunoutput--show-output-disabled`                                           | `checkrunoutput`           | forge-dashboard-30                     | audited, see below |
| `copychecklog--copied`                                                           | `copychecklog`             | forge-dashboard-31                     | audited, see below |
| `copychecklog--copying`                                                          | `copychecklog`             | forge-dashboard-31                     | audited, see below |
| `copychecklog--empty`                                                            | `copychecklog`             | not audited: the story renders nothing | n/a                |
| `copychecklog--failed-check`                                                     | `copychecklog`             | forge-dashboard-31                     | audited, see below |
| `copychecklog--focused`                                                          | `copychecklog`             | forge-dashboard-31                     | audited, see below |
| `copychecklog--log-unreadable`                                                   | `copychecklog`             | forge-dashboard-31                     | audited, see below |
| `copychecklog--no-job`                                                           | `copychecklog`             | forge-dashboard-31                     | audited, see below |
| `copychecklog--not-copyable`                                                     | `copychecklog`             | forge-dashboard-31                     | audited, see below |
| `disclosure--closed`                                                             | `disclosure`               | forge-dashboard-32                     | audited, see below |
| `disclosure--focused`                                                            | `disclosure`               | forge-dashboard-32                     | audited, see below |
| `disclosure--open`                                                               | `disclosure`               | forge-dashboard-32                     | audited, see below |
| `errorpage--not-found`                                                           | `errorpage`                | forge-dashboard-33                     | audited, see below |
| `errorpage--server-error`                                                        | `errorpage`                | forge-dashboard-33                     | audited, see below |
| `firstrefreshstatus--announces-by-changing-text`                                 | `firstrefreshstatus`       | forge-dashboard-34                     | audited, see below |
| `firstrefreshstatus--done`                                                       | `firstrefreshstatus`       | not audited: the story renders nothing | n/a                |
| `firstrefreshstatus--loading`                                                    | `firstrefreshstatus`       | forge-dashboard-34                     | audited, see below |
| `firstrefreshstatus--still-loading`                                              | `firstrefreshstatus`       | forge-dashboard-34                     | audited, see below |
| `footer--dev-build`                                                              | `footer`                   | forge-dashboard-35                     | audited, see below |
| `footer--privacy-page-current`                                                   | `footer`                   | forge-dashboard-35                     | audited, see below |
| `footer--released-version`                                                       | `footer`                   | forge-dashboard-35                     | audited, see below |
| `footer--version-request-fails`                                                  | `footer`                   | forge-dashboard-35                     | audited, see below |
| `footer--version-unresolved`                                                     | `footer`                   | forge-dashboard-35                     | audited, see below |
| `forgehealth--forgejo-budget-uses-its-own-short-name`                            | `forgehealth`              | forge-dashboard-36                     | audited, see below |
| `forgehealth--healthy`                                                           | `forgehealth`              | not audited: the story renders nothing | n/a                |
| `forgehealth--one-budget-names-itself`                                           | `forgehealth`              | forge-dashboard-36                     | audited, see below |
| `forgehealth--rate-limited-with-a-rate-limited-error-says-it-only-in-the-banner` | `forgehealth`              | forge-dashboard-36                     | audited, see below |
| `forgehealth--remaining-above-its-limit`                                         | `forgehealth`              | not audited: the story renders nothing | n/a                |
| `forgehealth--spent-graph-ql-budget-beside-a-healthy-rest-one`                   | `forgehealth`              | forge-dashboard-36                     | audited, see below |
| `forgehealth--starting-up`                                                       | `forgehealth`              | forge-dashboard-36                     | audited, see below |
| `forgehealth--unreachable-and-rate-limited`                                      | `forgehealth`              | forge-dashboard-36                     | audited, see below |
| `forgehealth--unreachable-draws-nothing`                                         | `forgehealth`              | not audited: the story renders nothing | n/a                |
| `listskeleton--default-rows`                                                     | `listskeleton`             | forge-dashboard-37                     | audited, see below |
| `listskeleton--long-list`                                                        | `listskeleton`             | forge-dashboard-37                     | audited, see below |
| `listskeleton--one-row`                                                          | `listskeleton`             | forge-dashboard-37                     | audited, see below |
| `navpills--all-counts`                                                           | `navpills`                 | forge-dashboard-38                     | audited, see below |
| `navpills--branches-with-no-pipeline`                                            | `navpills`                 | forge-dashboard-38                     | audited, see below |
| `navpills--empty`                                                                | `navpills`                 | forge-dashboard-38                     | audited, see below |
| `navpills--first-refresh-pending`                                                | `navpills`                 | forge-dashboard-38                     | audited, see below |
| `navpills--passing-only`                                                         | `navpills`                 | forge-dashboard-38                     | audited, see below |
| `navpills--stacked`                                                              | `navpills`                 | forge-dashboard-38                     | audited, see below |
| `navpills--waiting-for-approval`                                                 | `navpills`                 | forge-dashboard-38                     | audited, see below |
| `pipelinedialog--all-passing`                                                    | `pipelinedialog`           | forge-dashboard-39                     | audited, see below |
| `pipelinedialog--closed`                                                         | `pipelinedialog`           | forge-dashboard-39                     | audited, see below |
| `pipelinedialog--error`                                                          | `pipelinedialog`           | forge-dashboard-39                     | audited, see below |
| `pipelinedialog--failed-check`                                                   | `pipelinedialog`           | forge-dashboard-39                     | audited, see below |
| `pipelinedialog--focus-on-close`                                                 | `pipelinedialog`           | forge-dashboard-39                     | audited, see below |
| `pipelinedialog--loading`                                                        | `pipelinedialog`           | forge-dashboard-39                     | audited, see below |
| `pipelinedialog--main-branch`                                                    | `pipelinedialog`           | forge-dashboard-39                     | audited, see below |
| `pipelinedialog--no-checks`                                                      | `pipelinedialog`           | forge-dashboard-39                     | audited, see below |
| `pipelinedialog--running`                                                        | `pipelinedialog`           | forge-dashboard-40                     | audited, see below |
| `pullrequestdetailsdialog--closed`                                               | `pullrequestdetailsdialog` | forge-dashboard-41                     | audited, see below |
| `pullrequestdetailsdialog--cut-off`                                              | `pullrequestdetailsdialog` | forge-dashboard-41                     | audited, see below |
| `pullrequestdetailsdialog--dependency-bump`                                      | `pullrequestdetailsdialog` | forge-dashboard-41                     | audited, see below |
| `pullrequestdetailsdialog--empty`                                                | `pullrequestdetailsdialog` | forge-dashboard-41                     | audited, see below |
| `pullrequestdetailsdialog--error`                                                | `pullrequestdetailsdialog` | forge-dashboard-41                     | audited, see below |
| `pullrequestdetailsdialog--focus-on-try-again`                                   | `pullrequestdetailsdialog` | forge-dashboard-41                     | audited, see below |
| `pullrequestdetailsdialog--image-viewer`                                         | `pullrequestdetailsdialog` | forge-dashboard-41                     | audited, see below |
| `pullrequestdetailsdialog--issue`                                                | `pullrequestdetailsdialog` | forge-dashboard-41                     | audited, see below |
| `pullrequestdetailsdialog--loading`                                              | `pullrequestdetailsdialog` | forge-dashboard-42                     | audited, see below |
| `pullrequestdetailsdialog--pull-request`                                         | `pullrequestdetailsdialog` | forge-dashboard-42                     | audited, see below |
| `pullrequestdetailsdialog--release`                                              | `pullrequestdetailsdialog` | forge-dashboard-42                     | audited, see below |
| `pullrequestdetailsdialog--release-without-notes`                                | `pullrequestdetailsdialog` | forge-dashboard-42                     | audited, see below |
| `readfailurealert--error-with-retry`                                             | `readfailurealert`         | forge-dashboard-43                     | audited, see below |
| `readfailurealert--hidden`                                                       | `readfailurealert`         | not audited: the story renders nothing | n/a                |
| `readfailurealert--page-read-error`                                              | `readfailurealert`         | forge-dashboard-43                     | audited, see below |
| `repologo--insecure-url`                                                         | `repologo`                 | not audited: the story renders nothing | n/a                |
| `repologo--logo-fails-to-load`                                                   | `repologo`                 | forge-dashboard-44                     | audited, see below |
| `repologo--no-logo`                                                              | `repologo`                 | not audited: the story renders nothing | n/a                |
| `repologo--with-a-logo`                                                          | `repologo`                 | forge-dashboard-44                     | audited, see below |
| `settingsnav--behaviour-current`                                                 | `settingsnav`              | forge-dashboard-45                     | audited, see below |
| `settingsnav--connections-current`                                               | `settingsnav`              | forge-dashboard-45                     | audited, see below |
| `settingsnav--display-current`                                                   | `settingsnav`              | forge-dashboard-45                     | audited, see below |
| `settingsnav--focus-on-a-group`                                                  | `settingsnav`              | forge-dashboard-45                     | audited, see below |
| `settingsnav--integrations-current`                                              | `settingsnav`              | forge-dashboard-45                     | audited, see below |

## Findings

Stitch answered all 18 sheets. It cannot see the real tokens, so
its colour measurements were checked against `web/src/style.css` before
anything was adopted. `copychecklog` and the first `advisoriesdialog` sheet only
worked on a second try: Stitch's secret scrubber damaged the first
sheet's embedded image, and the other call timed out, so both were
uploaded as stacked parts.

### Rejected

- **Error and warning text under 4.5:1** (`readfailurealert`,
  `pipelinedialog`, `forgehealth`, `navpills`, `advisoriesdialog`).
  Stitch guessed GitHub's colours. The real `--critical` is 5.47:1 on
  white and 4.68:1 on `--critical-bg`, and `--warning` is 5.51:1 and
  4.87:1.
- **Button borders at 1.3:1** (nearly every sheet, except
  `advisoriesdialog`). Controls use `--control-border` (3.52:1). Only
  decorative card borders are `--border` (1.33:1), which SC 1.4.11 does
  not cover.
- **Disclosure trigger 38px high.** `Disclosure.svelte` sets
  `min-height: 44px`.
- **`ago(2026-01-01T00:00:00Z)` shown to users.** It is the story's
  fixture, and the story asserts it.
- **No `aria-busy` on the skeleton.** The list region sets it while the
  first load runs.
- **`Start loading` button, `Open details` and `Show checks` openers.**
  They are story harness controls, not app UI.
- **`boom` in an error message.** Fixture text.
- **Skeleton bars at 1.2:1.** Decorative, exempt from SC 1.4.11.
- **Footer links at 14 to 22px.** Every footer link has
  `min-height: var(--tap-floor)` (24px), and 44px under 761px. Stitch
  estimated from the image.
- **Reaction pill at about 22px.** `.reaction-pill` is 28px high, 44px on
  a phone, so it passes the 24px minimum of SC 2.5.8.
- **`Pull requests` link in `navpills`.** The story draws a bare `<a>` in
  a harness `<nav>`, not the app's nav item.
- **Icon buttons at 28 to 32px and `Show output` at about 24px.**
  `.run-icon-btn` is 44 by 44 and `.run-toggle` has `min-height: 44px`.
- **Expired or forbidden output shows `Hide output` with no panel.** The
  `checkrunoutput` sheet shows the error line and link in the panel.
- **Timestamps and sub text at 4.5 to 4.7:1.** `--ink-3` is 6.72:1 on
  white.
- **Amber badges at 3.2 to 3.5:1** (`Running` badge, waiting pill in
  `navpills`). `--warning` is 5.51:1 on white and 4.87:1 on its
  background.
- **`firstrefreshstatus` width jump from 128 to 354px.** The story
  harness shrink-wraps the box; it is not a layout shift in the app.
- **`copychecklog` contrast, focus ring and state claims.** Stitch
  guessed the accent as `#088395`. The real `--accent` is 4.95:1
  on white. The focus ring is a 2px `--accent` outline with a 2px offset,
  clearly visible in the focused story, and the notice text is `--ink-2`
  (7.46:1). The busy button is `aria-busy` and `aria-disabled`, the status
  is a `role="status"` region, and the hidden button with nothing to copy
  is intended.
- **`advisoriesdialog` contrast, focus and size claims.** Field labels,
  metadata and loading text use `--ink-2` (7.46:1). The `High` and
  `Medium` badges are `--critical` on `--critical-bg` (4.68:1) and `--warning` on
  `--warning-bg` (4.87:1). The focus ring is a 2px `--accent` outline.
  The filter pills, back and close buttons are 32px high, the loading
  line is a `role="status"` region, and the `closed` story shows only
  a trigger on purpose.
- **Considered, not adopted:** a reason for the disabled `Show output`
  button, a spinner, colour-only error pills (the sheets show error text
  and a tag reading `ERROR`), and the `forgehealth` "0 GraphQL budget but green
  pill" and refresh-button copy. These are opinions that need a product
  decision first.

### Adopted

- The `advisoriesdialog` buttons do not use `--control-border`. The
  filter pills and ghost buttons use `--border-strong` (1.62:1 on white),
  and the back and close buttons use `--border` (1.33:1). They have text
  or icon labels, so SC 1.4.11 may not need the border, but the
  control-border token is `--control-border` (3.52:1). Stitch's
  "borders under 2:1" was right for these. Other `--border-strong`
  users in the app are out of scope here.
- The failed-load logo story does not fail: the screenshot script
  serves every logo path, so it came out identical to the loaded story. A really
  failed load draws nothing (`RepoLogo` renders only the image), so it
  belongs with the stories that render nothing.
- The `Show details` summary in `forgehealth` has 11px text and no
  `min-height`. It is missing from the tap-floor selector list and from
  the hit-area sweep. Stitch's other size claims were rejected above.
- The `.details-collapsed summary` toggle in the pull request details
  dialog (13px text, no desktop `min-height`) and the `Copy output` and
  `Show output` buttons (`.pipeline-check-link`, 0.75rem text, no padding,
  no desktop `min-height`) are small targets. The excerpt box, which takes focus,
  sits over `Copy output`, so the spacing exception may not
  hold. Both are measured first, in the same ticket as the `Show details`
  summary.
- Stories for open-not-focused `disclosure` and a focused current
  group in `settingsnav`.

### Noted, not ticketed

- The `navpills` pending dash and `forgehealth` wording ("GitHub
  unreachable" while rate limited) are copy opinions. They need a
  product decision first.
- Stitch estimated sizes from images, so none of its pixel figures were
  adopted without measuring the CSS.
- Telling the user when the token can't read job logs is a feature idea
  from the `checkrunoutput` discussion, not a Stitch finding. It is
  ticketed on its own.
- The `errorpage` links already set `min-height: 24px`, so they pass.
- Dense key and value fields and the empty state's plain copy in
  `advisoriesdialog` are design opinions that need a product decision.
