# Storybook stories and the Stitch audit

Generated from `bun run storybook:screenshots` (93 stories). Each story is
either audited by a numbered Stitch request (answers recorded below as they
arrive) or renders nothing in that state, so there is nothing to look at.
Sheets sent to Stitch are in `sheets/`. Audited at desktop 1280px, light theme
only: the catalog has no phone or dark variants, so those remain covered only
by the route-level audit (forge-dashboard-1..27).

| Story                                                                            | Component                  | Stitch request                         | Outcome |
| -------------------------------------------------------------------------------- | -------------------------- | -------------------------------------- | ------- |
| `advisoriesdialog--advisory-detail`                                              | `advisoriesdialog`         | forge-dashboard-28                     | pending |
| `advisoriesdialog--closed`                                                       | `advisoriesdialog`         | forge-dashboard-28                     | pending |
| `advisoriesdialog--detail-focus-on-back`                                         | `advisoriesdialog`         | forge-dashboard-28                     | pending |
| `advisoriesdialog--empty`                                                        | `advisoriesdialog`         | forge-dashboard-28                     | pending |
| `advisoriesdialog--filtered-to-critical`                                         | `advisoriesdialog`         | forge-dashboard-28                     | pending |
| `advisoriesdialog--forgejo-list`                                                 | `advisoriesdialog`         | forge-dashboard-28                     | pending |
| `advisoriesdialog--loading`                                                      | `advisoriesdialog`         | forge-dashboard-28                     | pending |
| `advisoriesdialog--open-list`                                                    | `advisoriesdialog`         | forge-dashboard-28                     | pending |
| `advisoriesdialog--partial-list`                                                 | `advisoriesdialog`         | forge-dashboard-29                     | pending |
| `advisoriesdialog--request-failed`                                               | `advisoriesdialog`         | forge-dashboard-29                     | pending |
| `advisoriesdialog--unreadable`                                                   | `advisoriesdialog`         | forge-dashboard-29                     | pending |
| `checkrunoutput--closed`                                                         | `checkrunoutput`           | forge-dashboard-30                     | pending |
| `checkrunoutput--expired`                                                        | `checkrunoutput`           | forge-dashboard-30                     | pending |
| `checkrunoutput--forbidden`                                                      | `checkrunoutput`           | forge-dashboard-30                     | pending |
| `checkrunoutput--loading`                                                        | `checkrunoutput`           | forge-dashboard-30                     | pending |
| `checkrunoutput--no-output`                                                      | `checkrunoutput`           | forge-dashboard-30                     | pending |
| `checkrunoutput--output-cut`                                                     | `checkrunoutput`           | forge-dashboard-30                     | pending |
| `checkrunoutput--output-shown`                                                   | `checkrunoutput`           | forge-dashboard-30                     | pending |
| `checkrunoutput--show-output-disabled`                                           | `checkrunoutput`           | forge-dashboard-30                     | pending |
| `copychecklog--copied`                                                           | `copychecklog`             | forge-dashboard-31                     | pending |
| `copychecklog--copying`                                                          | `copychecklog`             | forge-dashboard-31                     | pending |
| `copychecklog--empty`                                                            | `copychecklog`             | not audited: the story renders nothing | n/a     |
| `copychecklog--failed-check`                                                     | `copychecklog`             | forge-dashboard-31                     | pending |
| `copychecklog--focused`                                                          | `copychecklog`             | forge-dashboard-31                     | pending |
| `copychecklog--log-unreadable`                                                   | `copychecklog`             | forge-dashboard-31                     | pending |
| `copychecklog--no-job`                                                           | `copychecklog`             | forge-dashboard-31                     | pending |
| `copychecklog--not-copyable`                                                     | `copychecklog`             | forge-dashboard-31                     | pending |
| `disclosure--closed`                                                             | `disclosure`               | forge-dashboard-32                     | pending |
| `disclosure--focused`                                                            | `disclosure`               | forge-dashboard-32                     | pending |
| `disclosure--open`                                                               | `disclosure`               | forge-dashboard-32                     | pending |
| `errorpage--not-found`                                                           | `errorpage`                | forge-dashboard-33                     | pending |
| `errorpage--server-error`                                                        | `errorpage`                | forge-dashboard-33                     | pending |
| `firstrefreshstatus--announces-by-changing-text`                                 | `firstrefreshstatus`       | forge-dashboard-34                     | pending |
| `firstrefreshstatus--done`                                                       | `firstrefreshstatus`       | not audited: the story renders nothing | n/a     |
| `firstrefreshstatus--loading`                                                    | `firstrefreshstatus`       | forge-dashboard-34                     | pending |
| `firstrefreshstatus--still-loading`                                              | `firstrefreshstatus`       | forge-dashboard-34                     | pending |
| `footer--dev-build`                                                              | `footer`                   | forge-dashboard-35                     | pending |
| `footer--privacy-page-current`                                                   | `footer`                   | forge-dashboard-35                     | pending |
| `footer--released-version`                                                       | `footer`                   | forge-dashboard-35                     | pending |
| `footer--version-request-fails`                                                  | `footer`                   | forge-dashboard-35                     | pending |
| `footer--version-unresolved`                                                     | `footer`                   | forge-dashboard-35                     | pending |
| `forgehealth--forgejo-budget-uses-its-own-short-name`                            | `forgehealth`              | forge-dashboard-36                     | pending |
| `forgehealth--healthy`                                                           | `forgehealth`              | not audited: the story renders nothing | n/a     |
| `forgehealth--one-budget-names-itself`                                           | `forgehealth`              | forge-dashboard-36                     | pending |
| `forgehealth--rate-limited-with-a-rate-limited-error-says-it-only-in-the-banner` | `forgehealth`              | forge-dashboard-36                     | pending |
| `forgehealth--remaining-above-its-limit`                                         | `forgehealth`              | not audited: the story renders nothing | n/a     |
| `forgehealth--spent-graph-ql-budget-beside-a-healthy-rest-one`                   | `forgehealth`              | forge-dashboard-36                     | pending |
| `forgehealth--starting-up`                                                       | `forgehealth`              | forge-dashboard-36                     | pending |
| `forgehealth--unreachable-and-rate-limited`                                      | `forgehealth`              | forge-dashboard-36                     | pending |
| `forgehealth--unreachable-draws-nothing`                                         | `forgehealth`              | not audited: the story renders nothing | n/a     |
| `listskeleton--default-rows`                                                     | `listskeleton`             | forge-dashboard-37                     | pending |
| `listskeleton--long-list`                                                        | `listskeleton`             | forge-dashboard-37                     | pending |
| `listskeleton--one-row`                                                          | `listskeleton`             | forge-dashboard-37                     | pending |
| `navpills--all-counts`                                                           | `navpills`                 | forge-dashboard-38                     | pending |
| `navpills--branches-with-no-pipeline`                                            | `navpills`                 | forge-dashboard-38                     | pending |
| `navpills--empty`                                                                | `navpills`                 | forge-dashboard-38                     | pending |
| `navpills--first-refresh-pending`                                                | `navpills`                 | forge-dashboard-38                     | pending |
| `navpills--passing-only`                                                         | `navpills`                 | forge-dashboard-38                     | pending |
| `navpills--stacked`                                                              | `navpills`                 | forge-dashboard-38                     | pending |
| `navpills--waiting-for-approval`                                                 | `navpills`                 | forge-dashboard-38                     | pending |
| `pipelinedialog--all-passing`                                                    | `pipelinedialog`           | forge-dashboard-39                     | pending |
| `pipelinedialog--closed`                                                         | `pipelinedialog`           | forge-dashboard-39                     | pending |
| `pipelinedialog--error`                                                          | `pipelinedialog`           | forge-dashboard-39                     | pending |
| `pipelinedialog--failed-check`                                                   | `pipelinedialog`           | forge-dashboard-39                     | pending |
| `pipelinedialog--focus-on-close`                                                 | `pipelinedialog`           | forge-dashboard-39                     | pending |
| `pipelinedialog--loading`                                                        | `pipelinedialog`           | forge-dashboard-39                     | pending |
| `pipelinedialog--main-branch`                                                    | `pipelinedialog`           | forge-dashboard-39                     | pending |
| `pipelinedialog--no-checks`                                                      | `pipelinedialog`           | forge-dashboard-39                     | pending |
| `pipelinedialog--running`                                                        | `pipelinedialog`           | forge-dashboard-40                     | pending |
| `pullrequestdetailsdialog--closed`                                               | `pullrequestdetailsdialog` | forge-dashboard-41                     | pending |
| `pullrequestdetailsdialog--cut-off`                                              | `pullrequestdetailsdialog` | forge-dashboard-41                     | pending |
| `pullrequestdetailsdialog--dependency-bump`                                      | `pullrequestdetailsdialog` | forge-dashboard-41                     | pending |
| `pullrequestdetailsdialog--empty`                                                | `pullrequestdetailsdialog` | forge-dashboard-41                     | pending |
| `pullrequestdetailsdialog--error`                                                | `pullrequestdetailsdialog` | forge-dashboard-41                     | pending |
| `pullrequestdetailsdialog--focus-on-try-again`                                   | `pullrequestdetailsdialog` | forge-dashboard-41                     | pending |
| `pullrequestdetailsdialog--image-viewer`                                         | `pullrequestdetailsdialog` | forge-dashboard-41                     | pending |
| `pullrequestdetailsdialog--issue`                                                | `pullrequestdetailsdialog` | forge-dashboard-41                     | pending |
| `pullrequestdetailsdialog--loading`                                              | `pullrequestdetailsdialog` | forge-dashboard-42                     | pending |
| `pullrequestdetailsdialog--pull-request`                                         | `pullrequestdetailsdialog` | forge-dashboard-42                     | pending |
| `pullrequestdetailsdialog--release`                                              | `pullrequestdetailsdialog` | forge-dashboard-42                     | pending |
| `pullrequestdetailsdialog--release-without-notes`                                | `pullrequestdetailsdialog` | forge-dashboard-42                     | pending |
| `readfailurealert--error-with-retry`                                             | `readfailurealert`         | forge-dashboard-43                     | pending |
| `readfailurealert--hidden`                                                       | `readfailurealert`         | not audited: the story renders nothing | n/a     |
| `readfailurealert--page-read-error`                                              | `readfailurealert`         | forge-dashboard-43                     | pending |
| `repologo--insecure-url`                                                         | `repologo`                 | not audited: the story renders nothing | n/a     |
| `repologo--logo-fails-to-load`                                                   | `repologo`                 | forge-dashboard-44                     | pending |
| `repologo--no-logo`                                                              | `repologo`                 | not audited: the story renders nothing | n/a     |
| `repologo--with-a-logo`                                                          | `repologo`                 | forge-dashboard-44                     | pending |
| `settingsnav--behaviour-current`                                                 | `settingsnav`              | forge-dashboard-45                     | pending |
| `settingsnav--connections-current`                                               | `settingsnav`              | forge-dashboard-45                     | pending |
| `settingsnav--display-current`                                                   | `settingsnav`              | forge-dashboard-45                     | pending |
| `settingsnav--focus-on-a-group`                                                  | `settingsnav`              | forge-dashboard-45                     | pending |
| `settingsnav--integrations-current`                                              | `settingsnav`              | forge-dashboard-45                     | pending |
