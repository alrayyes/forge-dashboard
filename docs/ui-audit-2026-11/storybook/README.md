# Storybook stories and the Stitch audit

Generated from `bun run storybook:screenshots` (93 stories). Each story is
either audited by a numbered Stitch request (answers recorded below as they
arrive) or renders nothing in that state, so there is nothing to look at.
Sheets sent to Stitch are in `sheets/`. Audited at desktop 1280px, light theme
only: the catalogue has no phone or dark variants, so those remain covered only
by the route-level audit (forge-dashboard-1 to 27).

| Story                                                                            | Component                  | Stitch request                         | Outcome                                     |
| -------------------------------------------------------------------------------- | -------------------------- | -------------------------------------- | ------------------------------------------- |
| `advisoriesdialog--advisory-detail`                                              | `advisoriesdialog`         | forge-dashboard-28                     | not completed (Stitch timed out)            |
| `advisoriesdialog--closed`                                                       | `advisoriesdialog`         | forge-dashboard-28                     | not completed (Stitch timed out)            |
| `advisoriesdialog--detail-focus-on-back`                                         | `advisoriesdialog`         | forge-dashboard-28                     | not completed (Stitch timed out)            |
| `advisoriesdialog--empty`                                                        | `advisoriesdialog`         | forge-dashboard-28                     | not completed (Stitch timed out)            |
| `advisoriesdialog--filtered-to-critical`                                         | `advisoriesdialog`         | forge-dashboard-28                     | not completed (Stitch timed out)            |
| `advisoriesdialog--forgejo-list`                                                 | `advisoriesdialog`         | forge-dashboard-28                     | not completed (Stitch timed out)            |
| `advisoriesdialog--loading`                                                      | `advisoriesdialog`         | forge-dashboard-28                     | not completed (Stitch timed out)            |
| `advisoriesdialog--open-list`                                                    | `advisoriesdialog`         | forge-dashboard-28                     | not completed (Stitch timed out)            |
| `advisoriesdialog--partial-list`                                                 | `advisoriesdialog`         | forge-dashboard-29                     | audited, see below                          |
| `advisoriesdialog--request-failed`                                               | `advisoriesdialog`         | forge-dashboard-29                     | audited, see below                          |
| `advisoriesdialog--unreadable`                                                   | `advisoriesdialog`         | forge-dashboard-29                     | audited, see below                          |
| `checkrunoutput--closed`                                                         | `checkrunoutput`           | forge-dashboard-30                     | audited, see below                          |
| `checkrunoutput--expired`                                                        | `checkrunoutput`           | forge-dashboard-30                     | audited, see below                          |
| `checkrunoutput--forbidden`                                                      | `checkrunoutput`           | forge-dashboard-30                     | audited, see below                          |
| `checkrunoutput--loading`                                                        | `checkrunoutput`           | forge-dashboard-30                     | audited, see below                          |
| `checkrunoutput--no-output`                                                      | `checkrunoutput`           | forge-dashboard-30                     | audited, see below                          |
| `checkrunoutput--output-cut`                                                     | `checkrunoutput`           | forge-dashboard-30                     | audited, see below                          |
| `checkrunoutput--output-shown`                                                   | `checkrunoutput`           | forge-dashboard-30                     | audited, see below                          |
| `checkrunoutput--show-output-disabled`                                           | `checkrunoutput`           | forge-dashboard-30                     | audited, see below                          |
| `copychecklog--copied`                                                           | `copychecklog`             | forge-dashboard-31                     | not completed (Stitch showed a blank sheet) |
| `copychecklog--copying`                                                          | `copychecklog`             | forge-dashboard-31                     | not completed (Stitch showed a blank sheet) |
| `copychecklog--empty`                                                            | `copychecklog`             | not audited: the story renders nothing | n/a                                         |
| `copychecklog--failed-check`                                                     | `copychecklog`             | forge-dashboard-31                     | not completed (Stitch showed a blank sheet) |
| `copychecklog--focused`                                                          | `copychecklog`             | forge-dashboard-31                     | not completed (Stitch showed a blank sheet) |
| `copychecklog--log-unreadable`                                                   | `copychecklog`             | forge-dashboard-31                     | not completed (Stitch showed a blank sheet) |
| `copychecklog--no-job`                                                           | `copychecklog`             | forge-dashboard-31                     | not completed (Stitch showed a blank sheet) |
| `copychecklog--not-copyable`                                                     | `copychecklog`             | forge-dashboard-31                     | not completed (Stitch showed a blank sheet) |
| `disclosure--closed`                                                             | `disclosure`               | forge-dashboard-32                     | audited, see below                          |
| `disclosure--focused`                                                            | `disclosure`               | forge-dashboard-32                     | audited, see below                          |
| `disclosure--open`                                                               | `disclosure`               | forge-dashboard-32                     | audited, see below                          |
| `errorpage--not-found`                                                           | `errorpage`                | forge-dashboard-33                     | audited, see below                          |
| `errorpage--server-error`                                                        | `errorpage`                | forge-dashboard-33                     | audited, see below                          |
| `firstrefreshstatus--announces-by-changing-text`                                 | `firstrefreshstatus`       | forge-dashboard-34                     | audited, see below                          |
| `firstrefreshstatus--done`                                                       | `firstrefreshstatus`       | not audited: the story renders nothing | n/a                                         |
| `firstrefreshstatus--loading`                                                    | `firstrefreshstatus`       | forge-dashboard-34                     | audited, see below                          |
| `firstrefreshstatus--still-loading`                                              | `firstrefreshstatus`       | forge-dashboard-34                     | audited, see below                          |
| `footer--dev-build`                                                              | `footer`                   | forge-dashboard-35                     | audited, see below                          |
| `footer--privacy-page-current`                                                   | `footer`                   | forge-dashboard-35                     | audited, see below                          |
| `footer--released-version`                                                       | `footer`                   | forge-dashboard-35                     | audited, see below                          |
| `footer--version-request-fails`                                                  | `footer`                   | forge-dashboard-35                     | audited, see below                          |
| `footer--version-unresolved`                                                     | `footer`                   | forge-dashboard-35                     | audited, see below                          |
| `forgehealth--forgejo-budget-uses-its-own-short-name`                            | `forgehealth`              | forge-dashboard-36                     | audited, see below                          |
| `forgehealth--healthy`                                                           | `forgehealth`              | not audited: the story renders nothing | n/a                                         |
| `forgehealth--one-budget-names-itself`                                           | `forgehealth`              | forge-dashboard-36                     | audited, see below                          |
| `forgehealth--rate-limited-with-a-rate-limited-error-says-it-only-in-the-banner` | `forgehealth`              | forge-dashboard-36                     | audited, see below                          |
| `forgehealth--remaining-above-its-limit`                                         | `forgehealth`              | not audited: the story renders nothing | n/a                                         |
| `forgehealth--spent-graph-ql-budget-beside-a-healthy-rest-one`                   | `forgehealth`              | forge-dashboard-36                     | audited, see below                          |
| `forgehealth--starting-up`                                                       | `forgehealth`              | forge-dashboard-36                     | audited, see below                          |
| `forgehealth--unreachable-and-rate-limited`                                      | `forgehealth`              | forge-dashboard-36                     | audited, see below                          |
| `forgehealth--unreachable-draws-nothing`                                         | `forgehealth`              | not audited: the story renders nothing | n/a                                         |
| `listskeleton--default-rows`                                                     | `listskeleton`             | forge-dashboard-37                     | audited, see below                          |
| `listskeleton--long-list`                                                        | `listskeleton`             | forge-dashboard-37                     | audited, see below                          |
| `listskeleton--one-row`                                                          | `listskeleton`             | forge-dashboard-37                     | audited, see below                          |
| `navpills--all-counts`                                                           | `navpills`                 | forge-dashboard-38                     | audited, see below                          |
| `navpills--branches-with-no-pipeline`                                            | `navpills`                 | forge-dashboard-38                     | audited, see below                          |
| `navpills--empty`                                                                | `navpills`                 | forge-dashboard-38                     | audited, see below                          |
| `navpills--first-refresh-pending`                                                | `navpills`                 | forge-dashboard-38                     | audited, see below                          |
| `navpills--passing-only`                                                         | `navpills`                 | forge-dashboard-38                     | audited, see below                          |
| `navpills--stacked`                                                              | `navpills`                 | forge-dashboard-38                     | audited, see below                          |
| `navpills--waiting-for-approval`                                                 | `navpills`                 | forge-dashboard-38                     | audited, see below                          |
| `pipelinedialog--all-passing`                                                    | `pipelinedialog`           | forge-dashboard-39                     | audited, see below                          |
| `pipelinedialog--closed`                                                         | `pipelinedialog`           | forge-dashboard-39                     | audited, see below                          |
| `pipelinedialog--error`                                                          | `pipelinedialog`           | forge-dashboard-39                     | audited, see below                          |
| `pipelinedialog--failed-check`                                                   | `pipelinedialog`           | forge-dashboard-39                     | audited, see below                          |
| `pipelinedialog--focus-on-close`                                                 | `pipelinedialog`           | forge-dashboard-39                     | audited, see below                          |
| `pipelinedialog--loading`                                                        | `pipelinedialog`           | forge-dashboard-39                     | audited, see below                          |
| `pipelinedialog--main-branch`                                                    | `pipelinedialog`           | forge-dashboard-39                     | audited, see below                          |
| `pipelinedialog--no-checks`                                                      | `pipelinedialog`           | forge-dashboard-39                     | audited, see below                          |
| `pipelinedialog--running`                                                        | `pipelinedialog`           | forge-dashboard-40                     | audited, see below                          |
| `pullrequestdetailsdialog--closed`                                               | `pullrequestdetailsdialog` | forge-dashboard-41                     | audited, see below                          |
| `pullrequestdetailsdialog--cut-off`                                              | `pullrequestdetailsdialog` | forge-dashboard-41                     | audited, see below                          |
| `pullrequestdetailsdialog--dependency-bump`                                      | `pullrequestdetailsdialog` | forge-dashboard-41                     | audited, see below                          |
| `pullrequestdetailsdialog--empty`                                                | `pullrequestdetailsdialog` | forge-dashboard-41                     | audited, see below                          |
| `pullrequestdetailsdialog--error`                                                | `pullrequestdetailsdialog` | forge-dashboard-41                     | audited, see below                          |
| `pullrequestdetailsdialog--focus-on-try-again`                                   | `pullrequestdetailsdialog` | forge-dashboard-41                     | audited, see below                          |
| `pullrequestdetailsdialog--image-viewer`                                         | `pullrequestdetailsdialog` | forge-dashboard-41                     | audited, see below                          |
| `pullrequestdetailsdialog--issue`                                                | `pullrequestdetailsdialog` | forge-dashboard-41                     | audited, see below                          |
| `pullrequestdetailsdialog--loading`                                              | `pullrequestdetailsdialog` | forge-dashboard-42                     | audited, see below                          |
| `pullrequestdetailsdialog--pull-request`                                         | `pullrequestdetailsdialog` | forge-dashboard-42                     | audited, see below                          |
| `pullrequestdetailsdialog--release`                                              | `pullrequestdetailsdialog` | forge-dashboard-42                     | audited, see below                          |
| `pullrequestdetailsdialog--release-without-notes`                                | `pullrequestdetailsdialog` | forge-dashboard-42                     | audited, see below                          |
| `readfailurealert--error-with-retry`                                             | `readfailurealert`         | forge-dashboard-43                     | audited, see below                          |
| `readfailurealert--hidden`                                                       | `readfailurealert`         | not audited: the story renders nothing | n/a                                         |
| `readfailurealert--page-read-error`                                              | `readfailurealert`         | forge-dashboard-43                     | audited, see below                          |
| `repologo--insecure-url`                                                         | `repologo`                 | not audited: the story renders nothing | n/a                                         |
| `repologo--logo-fails-to-load`                                                   | `repologo`                 | forge-dashboard-44                     | audited, see below                          |
| `repologo--no-logo`                                                              | `repologo`                 | not audited: the story renders nothing | n/a                                         |
| `repologo--with-a-logo`                                                          | `repologo`                 | forge-dashboard-44                     | audited, see below                          |
| `settingsnav--behaviour-current`                                                 | `settingsnav`              | forge-dashboard-45                     | audited, see below                          |
| `settingsnav--connections-current`                                               | `settingsnav`              | forge-dashboard-45                     | audited, see below                          |
| `settingsnav--display-current`                                                   | `settingsnav`              | forge-dashboard-45                     | audited, see below                          |
| `settingsnav--focus-on-a-group`                                                  | `settingsnav`              | forge-dashboard-45                     | audited, see below                          |
| `settingsnav--integrations-current`                                              | `settingsnav`              | forge-dashboard-45                     | audited, see below                          |

## Findings

Stitch answered 15 of the 18 sheets. It cannot see the real tokens, so
its colour measurements were checked against `web/src/style.css` before
anything was adopted. Requests 28 (`advisoriesdialog`, first sheet) and
31 (`copychecklog`) did not finish and stay open.

### Rejected

- **Error and warning text under 4.5:1** (`readfailurealert`,
  `pipelinedialog`, `forgehealth`, `navpills`, `advisoriesdialog`).
  Stitch guessed GitHub's colours. The real `--critical` is 5.47:1 on
  white and 4.68:1 on `--critical-bg`, and `--warning` is 5.51:1 and
  4.87:1.
- **Button borders at 1.3:1** (nearly every sheet). Controls use
  `--control-border` (3.52:1). Only decorative card borders are
  `--border` (1.33:1), which SC 1.4.11 does not cover.
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

### Adopted

- #3890: the failed-load logo story draws the logo, because the
  screenshot script serves every logo path.
- #3891: small standalone hit areas (footer links, `Pull requests`,
  `Show details`, reaction pill). Stitch's heights are estimates, so the
  ticket starts by measuring.
- #3892: stories for open-not-focused `disclosure` and a focused current
  group in `settingsnav`.

### Noted, not ticketed

- The `navpills` pending dash and `forgehealth` wording ("GitHub
  unreachable" while rate limited) are copy opinions. They need a
  product decision first.
- The sheets are cropped at 1:1 or scaled to 56%, so Stitch's size
  estimates from the dialog sheets carry a rounding error.
