# Changelog

## [0.85.0](https://github.com/alrayyes/forge-dashboard/compare/v0.84.0...v0.85.0) (2026-09-19)


### Features

* **ci:** fire repository_dispatch at the SDK repos when the spec changes ([#475](https://github.com/alrayyes/forge-dashboard/issues/475)) ([24ae3db](https://github.com/alrayyes/forge-dashboard/commit/24ae3db021a76ec8b51946d8280c2fc15ba0c2c5))

## [0.84.0](https://github.com/alrayyes/forge-dashboard/compare/v0.83.0...v0.84.0) (2026-09-19)


### Features

* **web:** pill reads "Passed" for CI once there's no Merge button ([#467](https://github.com/alrayyes/forge-dashboard/issues/467)) ([62fc2fa](https://github.com/alrayyes/forge-dashboard/commit/62fc2fa0f79e746ff112940025b2db359ef42be9)), closes [#466](https://github.com/alrayyes/forge-dashboard/issues/466)


### Bug Fixes

* **api:** declare bearerAuth on every session-authenticated operation ([#473](https://github.com/alrayyes/forge-dashboard/issues/473)) ([ad7cce2](https://github.com/alrayyes/forge-dashboard/commit/ad7cce2291d2654a5b48ba5030ab2b3856f36c3e)), closes [#452](https://github.com/alrayyes/forge-dashboard/issues/452)
* **web:** keep a pull request in place while its Merge is being confirmed ([#469](https://github.com/alrayyes/forge-dashboard/issues/469)) ([6706353](https://github.com/alrayyes/forge-dashboard/commit/67063535ba34fc9e71c07b08af7422598e11024a)), closes [#468](https://github.com/alrayyes/forge-dashboard/issues/468)
* **web:** widen the repo column so an ordinary owner/repo name isn't truncated ([#471](https://github.com/alrayyes/forge-dashboard/issues/471)) ([46bf0e2](https://github.com/alrayyes/forge-dashboard/commit/46bf0e26923f3879e9f0c4ff5af56400e28847de)), closes [#470](https://github.com/alrayyes/forge-dashboard/issues/470)

## [0.83.0](https://github.com/alrayyes/forge-dashboard/compare/v0.82.0...v0.83.0) (2026-09-19)


### Features

* **web:** show the full repo name on hover when truncated ([#464](https://github.com/alrayyes/forge-dashboard/issues/464)) ([3bc0e41](https://github.com/alrayyes/forge-dashboard/commit/3bc0e41de6a658e95083ea577aef74d8432aa56a)), closes [#463](https://github.com/alrayyes/forge-dashboard/issues/463)


### Bug Fixes

* **web:** don't show "View run" for a skipped pipeline check ([#462](https://github.com/alrayyes/forge-dashboard/issues/462)) ([e3612c0](https://github.com/alrayyes/forge-dashboard/commit/e3612c0df437a688373795eacd8b27ffd6bb99e6)), closes [#461](https://github.com/alrayyes/forge-dashboard/issues/461)
* **web:** stop the Merge button reporting a false failure ([#460](https://github.com/alrayyes/forge-dashboard/issues/460)) ([837bc12](https://github.com/alrayyes/forge-dashboard/commit/837bc12ae4b43fb22890f18351066bc5356b7a8e)), closes [#459](https://github.com/alrayyes/forge-dashboard/issues/459)

## [0.82.0](https://github.com/alrayyes/forge-dashboard/compare/v0.81.0...v0.82.0) (2026-09-19)


### Features

* **dashboard:** log rate-limit exhaustion and recovery transitions ([#454](https://github.com/alrayyes/forge-dashboard/issues/454)) ([0cf6f03](https://github.com/alrayyes/forge-dashboard/commit/0cf6f03d55e1521f9aed77fcff2dac0d15f38200)), closes [#453](https://github.com/alrayyes/forge-dashboard/issues/453)


### Bug Fixes

* **dashboard:** forward PullRequestChecker through GenericSource ([#457](https://github.com/alrayyes/forge-dashboard/issues/457)) ([614a13f](https://github.com/alrayyes/forge-dashboard/commit/614a13fee232fec8777302fdc80b9c5bd6c8bca3)), closes [#455](https://github.com/alrayyes/forge-dashboard/issues/455)

## [0.81.0](https://github.com/alrayyes/forge-dashboard/compare/v0.80.1...v0.81.0) (2026-09-19)


### Features

* **web:** warn before a rate-limit budget hits zero, not just at it ([#451](https://github.com/alrayyes/forge-dashboard/issues/451)) ([6cf1a53](https://github.com/alrayyes/forge-dashboard/commit/6cf1a5342f3713026285ac7d97a36ba697b487c6)), closes [#450](https://github.com/alrayyes/forge-dashboard/issues/450)

## [0.80.1](https://github.com/alrayyes/forge-dashboard/compare/v0.80.0...v0.80.1) (2026-09-19)


### Bug Fixes

* **web:** enlarge row action buttons past the bare WCAG target-size floor ([#446](https://github.com/alrayyes/forge-dashboard/issues/446)) ([5ce9e62](https://github.com/alrayyes/forge-dashboard/commit/5ce9e62d72686d5a60279debcbd457c9e47d15b0)), closes [#445](https://github.com/alrayyes/forge-dashboard/issues/445)
* **web:** keep Update branch showing "Updating…" until it's actually done ([#448](https://github.com/alrayyes/forge-dashboard/issues/448)) ([ccb5c45](https://github.com/alrayyes/forge-dashboard/commit/ccb5c45115ac72cf20a5fac2f9a7b4f36d2984e9)), closes [#447](https://github.com/alrayyes/forge-dashboard/issues/447)

## [0.80.0](https://github.com/alrayyes/forge-dashboard/compare/v0.79.1...v0.80.0) (2026-09-19)


### Features

* per-repo auto-update-branch with a bulk on/off ([#443](https://github.com/alrayyes/forge-dashboard/issues/443)) ([9e5b82c](https://github.com/alrayyes/forge-dashboard/commit/9e5b82c0a5a27a49fa185920f4284e7f51599062))

## [0.79.1](https://github.com/alrayyes/forge-dashboard/compare/v0.79.0...v0.79.1) (2026-09-19)


### Bug Fixes

* **api:** serialize RepoStatus.url and .canManageWebhooks ([#439](https://github.com/alrayyes/forge-dashboard/issues/439)) ([af943a4](https://github.com/alrayyes/forge-dashboard/commit/af943a44cc824e40ceb1cbd40e4e5a0c008132d6)), closes [#438](https://github.com/alrayyes/forge-dashboard/issues/438)

## [0.79.0](https://github.com/alrayyes/forge-dashboard/compare/v0.78.0...v0.79.0) (2026-09-19)


### Features

* show a pull request's CI pipeline jobs, linking to the forge ([#433](https://github.com/alrayyes/forge-dashboard/issues/433)) ([9be2df1](https://github.com/alrayyes/forge-dashboard/commit/9be2df1e5648893c9c8cc6da1b3311200a8f96be)), closes [#425](https://github.com/alrayyes/forge-dashboard/issues/425)
* surface GraphQL rate-limit cost per poll on Insights ([#441](https://github.com/alrayyes/forge-dashboard/issues/441)) ([57d5978](https://github.com/alrayyes/forge-dashboard/commit/57d5978a2bad35468335a9b52d302e9eb83892f6))


### Bug Fixes

* **lint:** bring golangci-lint config up to spec and fix what it found ([#434](https://github.com/alrayyes/forge-dashboard/issues/434)) ([8963869](https://github.com/alrayyes/forge-dashboard/commit/8963869eb25262c971de69543f6c1c228e2625f6))
* **lint:** fix wrapcheck/nlreturn/modernize findings that broke main CI ([#437](https://github.com/alrayyes/forge-dashboard/issues/437)) ([878191e](https://github.com/alrayyes/forge-dashboard/commit/878191e75401bacbf13fd8104482c4993a863ee6))
* stop repeating "Rate limit exceeded." under a rate-limited forge's chip ([#431](https://github.com/alrayyes/forge-dashboard/issues/431)) ([1e71223](https://github.com/alrayyes/forge-dashboard/commit/1e71223be90412d912489542e8cf947924fa7ddd))

## [0.78.0](https://github.com/alrayyes/forge-dashboard/compare/v0.77.2...v0.78.0) (2026-09-19)


### Features

* **webhooks:** add a bulk "set up webhooks for all repos" action ([#427](https://github.com/alrayyes/forge-dashboard/issues/427)) ([a0fb8b6](https://github.com/alrayyes/forge-dashboard/commit/a0fb8b6b2ec8207e184d4cbefe1c5bf90696d7ad)), closes [#380](https://github.com/alrayyes/forge-dashboard/issues/380)

## [0.77.2](https://github.com/alrayyes/forge-dashboard/compare/v0.77.1...v0.77.2) (2026-09-19)


### Bug Fixes

* stop the update-branch Retry test racing its own click handler ([#424](https://github.com/alrayyes/forge-dashboard/issues/424)) ([c618be0](https://github.com/alrayyes/forge-dashboard/commit/c618be0df99160b8882aa52c21241ace259b4494))

## [0.77.1](https://github.com/alrayyes/forge-dashboard/compare/v0.77.0...v0.77.1) (2026-09-18)


### Bug Fixes

* hide the blocked merge-status pill while CI is still running ([#421](https://github.com/alrayyes/forge-dashboard/issues/421)) ([66bbebf](https://github.com/alrayyes/forge-dashboard/commit/66bbebfdda53eaaf3f5af0b81d9552201f8eff52))

## [0.77.0](https://github.com/alrayyes/forge-dashboard/compare/v0.76.2...v0.77.0) (2026-09-18)


### Features

* add structured HTTP access logging ([#420](https://github.com/alrayyes/forge-dashboard/issues/420)) ([0e3cdca](https://github.com/alrayyes/forge-dashboard/commit/0e3cdca1876ff21540801b5619a838491f7003c7))

## [0.76.2](https://github.com/alrayyes/forge-dashboard/compare/v0.76.1...v0.76.2) (2026-09-18)


### Bug Fixes

* hide the Merge button while a PR's CI is still running ([#415](https://github.com/alrayyes/forge-dashboard/issues/415)) ([8bc56ce](https://github.com/alrayyes/forge-dashboard/commit/8bc56ceff7a84da992950bf6353f77e5e85e3089))
* stop the force-refresh test racing its own mocked response ([#416](https://github.com/alrayyes/forge-dashboard/issues/416)) ([8c320a7](https://github.com/alrayyes/forge-dashboard/commit/8c320a77b10f0740d760cb8fba29f787884758ca))

## [0.76.1](https://github.com/alrayyes/forge-dashboard/compare/v0.76.0...v0.76.1) (2026-09-18)


### Bug Fixes

* collapse the webhooks table to a stacked list at phone width ([#412](https://github.com/alrayyes/forge-dashboard/issues/412)) ([12999da](https://github.com/alrayyes/forge-dashboard/commit/12999da847ec60509ebccb80ade52fd81c38765b))

## [0.76.0](https://github.com/alrayyes/forge-dashboard/compare/v0.75.0...v0.76.0) (2026-09-18)


### Features

* cache ETags for this client's own REST GET calls ([#408](https://github.com/alrayyes/forge-dashboard/issues/408)) ([13dce95](https://github.com/alrayyes/forge-dashboard/commit/13dce952c61e3ec0923a7ce931551f030f994c3d))
* filter the issues query by since on repeat polls, reconcile the delta ([#409](https://github.com/alrayyes/forge-dashboard/issues/409)) ([eb37350](https://github.com/alrayyes/forge-dashboard/commit/eb37350cc354738c4df1eff9afde95dad2a29a89))

## [0.75.0](https://github.com/alrayyes/forge-dashboard/compare/v0.74.0...v0.75.0) (2026-09-18)


### Features

* back off the next scheduled refresh when a rate-limit budget is critical ([#407](https://github.com/alrayyes/forge-dashboard/issues/407)) ([23cdb38](https://github.com/alrayyes/forge-dashboard/commit/23cdb380da85895f97d4af02a56f53265a1be2a0))
* raise the default background poll interval to 20 minutes ([#406](https://github.com/alrayyes/forge-dashboard/issues/406)) ([b6566ce](https://github.com/alrayyes/forge-dashboard/commit/b6566ceacd9a15adb46868a81f857d70bf0d4375))

## [0.74.0](https://github.com/alrayyes/forge-dashboard/compare/v0.73.0...v0.74.0) (2026-09-18)


### Features

* split GitHub rate-limit gauges, add exceeded-budget banner ([#404](https://github.com/alrayyes/forge-dashboard/issues/404)) ([58c2dd6](https://github.com/alrayyes/forge-dashboard/commit/58c2dd6ac46b43b96abced38fa749300ab08e32e))

## [0.73.0](https://github.com/alrayyes/forge-dashboard/compare/v0.72.0...v0.73.0) (2026-09-18)


### Features

* add a Clear filters button to the shared filter bar ([#389](https://github.com/alrayyes/forge-dashboard/issues/389)) ([e0d4fbd](https://github.com/alrayyes/forge-dashboard/commit/e0d4fbdd4bbdb6d8ce689b85f037d10b1035131d)), closes [#354](https://github.com/alrayyes/forge-dashboard/issues/354)
* add a copy button for the webhook secret ([#123](https://github.com/alrayyes/forge-dashboard/issues/123)) ([f2e4fb8](https://github.com/alrayyes/forge-dashboard/commit/f2e4fb8baf1877bc4df348290960588dfd16c101))
* add a link to the repo in the footer ([#120](https://github.com/alrayyes/forge-dashboard/issues/120)) ([24e1b8d](https://github.com/alrayyes/forge-dashboard/commit/24e1b8d389bb8bc0699899428b58695c7284610d))
* add a LOG_LEVEL debug mode logging every outbound request ([#146](https://github.com/alrayyes/forge-dashboard/issues/146)) ([b668560](https://github.com/alrayyes/forge-dashboard/commit/b668560072fd4fed1738493b843210b1d1fdabf1)), closes [#145](https://github.com/alrayyes/forge-dashboard/issues/145)
* add a Renovate rebase button to pull request rows ([7f3d9aa](https://github.com/alrayyes/forge-dashboard/commit/7f3d9aad8b161dd0eaf54aaaf0faa62aada3da3d))
* add a Renovate rebase button to pull request rows ([66113a8](https://github.com/alrayyes/forge-dashboard/commit/66113a841a86eab222f176b1a1f9a62489037ea5)), closes [#333](https://github.com/alrayyes/forge-dashboard/issues/333)
* add an in-app release history page ([#90](https://github.com/alrayyes/forge-dashboard/issues/90)) ([6b2ec06](https://github.com/alrayyes/forge-dashboard/commit/6b2ec06501cac6d27dde2ef6abf3ee088e3f6898)), closes [#62](https://github.com/alrayyes/forge-dashboard/issues/62)
* add auto-updating README screenshots, refreshed on every release ([#118](https://github.com/alrayyes/forge-dashboard/issues/118)) ([4f74fe0](https://github.com/alrayyes/forge-dashboard/commit/4f74fe024d3d8c2aee574c66fa266f5c8e899dd0)), closes [#113](https://github.com/alrayyes/forge-dashboard/issues/113)
* add Dependabot rebase/recreate buttons to pull request rows ([99f093e](https://github.com/alrayyes/forge-dashboard/commit/99f093e1eec66e04b8201cc7cfbf7dd372ba265e))
* add Dependabot rebase/recreate buttons to pull request rows ([bee0b7c](https://github.com/alrayyes/forge-dashboard/commit/bee0b7c7e5ef0240f12c9a45936087acdd02b05c)), closes [#332](https://github.com/alrayyes/forge-dashboard/issues/332)
* add group-by-forge, alongside group-by-repo ([#105](https://github.com/alrayyes/forge-dashboard/issues/105)) ([a01dd3d](https://github.com/alrayyes/forge-dashboard/commit/a01dd3da105b9d52f6344275057c81600de2dfb1)), closes [#102](https://github.com/alrayyes/forge-dashboard/issues/102)
* admin user management ([#19](https://github.com/alrayyes/forge-dashboard/issues/19)) ([68448e8](https://github.com/alrayyes/forge-dashboard/commit/68448e8e1b56dc3dcb3e34528d853cd235ada1f9))
* **api:** add a rate-limit schema to ForgeHealth ([#133](https://github.com/alrayyes/forge-dashboard/issues/133)) ([073e7f4](https://github.com/alrayyes/forge-dashboard/commit/073e7f4f308ce7544b5535d344d602c38f128538))
* **auth:** add personal API tokens alongside passkey sessions ([#316](https://github.com/alrayyes/forge-dashboard/issues/316)) ([3968284](https://github.com/alrayyes/forge-dashboard/commit/396828429abe7d5feb90861b20e98d54b835d26b)), closes [#301](https://github.com/alrayyes/forge-dashboard/issues/301)
* click a CI status to filter the pull request list by it ([#52](https://github.com/alrayyes/forge-dashboard/issues/52)) ([716e420](https://github.com/alrayyes/forge-dashboard/commit/716e42039e1316d0076867ecca26cbbf11354c84))
* click a label chip to filter the list by that label ([#55](https://github.com/alrayyes/forge-dashboard/issues/55)) ([20ed445](https://github.com/alrayyes/forge-dashboard/commit/20ed445cdb1637a0ad99c0d48d4945b2ef6afe34)), closes [#45](https://github.com/alrayyes/forge-dashboard/issues/45)
* dashboard sharing ([#21](https://github.com/alrayyes/forge-dashboard/issues/21)) ([6b68928](https://github.com/alrayyes/forge-dashboard/commit/6b68928ec425dd975539015c0ec210f01b59b280))
* **dashboard:** add a force-refresh button ([#225](https://github.com/alrayyes/forge-dashboard/issues/225)) ([ecbd4c8](https://github.com/alrayyes/forge-dashboard/commit/ecbd4c84390660ce03dd74144b35db1364f4632d)), closes [#219](https://github.com/alrayyes/forge-dashboard/issues/219)
* **dashboard:** add a persistent top nav, shared across every page ([#270](https://github.com/alrayyes/forge-dashboard/issues/270)) ([df308da](https://github.com/alrayyes/forge-dashboard/commit/df308da0b87bf6d99038536ff049fcd4072819bd)), closes [#269](https://github.com/alrayyes/forge-dashboard/issues/269)
* **dashboard:** add Aggregator/Manager.RefreshRepo for scoped refreshes ([#156](https://github.com/alrayyes/forge-dashboard/issues/156)) ([f9fa3df](https://github.com/alrayyes/forge-dashboard/commit/f9fa3df41d6db3a7384f704845793e72ce93f015))
* **dashboard:** add filters and sorting to the webhooks page ([#266](https://github.com/alrayyes/forge-dashboard/issues/266)) ([63f524e](https://github.com/alrayyes/forge-dashboard/commit/63f524e4bdcae434ecc937234e2fd1475adf8840))
* **dashboard:** add Forge() and RepoRefresher to the Source interface ([#150](https://github.com/alrayyes/forge-dashboard/issues/150)) ([5aef5e1](https://github.com/alrayyes/forge-dashboard/commit/5aef5e12e4699279156bf267d348ba8f4b12225c))
* **dashboard:** check a repo's webhook via the forge API, ahead of the delivery table ([#243](https://github.com/alrayyes/forge-dashboard/issues/243)) ([3ddb094](https://github.com/alrayyes/forge-dashboard/commit/3ddb094b87b654637617ba2d632584f153613a10))
* **dashboard:** classify unreachable-forge errors into actionable kinds ([#230](https://github.com/alrayyes/forge-dashboard/issues/230)) ([3f02b51](https://github.com/alrayyes/forge-dashboard/commit/3f02b51003f4d0205d8b7f16628964fbafdf5395))
* **dashboard:** give webhook coverage its own paginated page ([#246](https://github.com/alrayyes/forge-dashboard/issues/246)) ([63e98cb](https://github.com/alrayyes/forge-dashboard/commit/63e98cba45df27c5444aebf4c601815e39e40f14))
* **dashboard:** hide Renovate's Dependency Dashboard issue by default ([#203](https://github.com/alrayyes/forge-dashboard/issues/203)) ([57dd2fc](https://github.com/alrayyes/forge-dashboard/commit/57dd2fc1c3f57d31262d305c2031cd54e0583055))
* **dashboard:** make the brand logo/wordmark link to home ([#278](https://github.com/alrayyes/forge-dashboard/issues/278)) ([f845533](https://github.com/alrayyes/forge-dashboard/commit/f845533314c81d17cb5baedec218449f70a643b3)), closes [#277](https://github.com/alrayyes/forge-dashboard/issues/277)
* **dashboard:** show merge conflicts/blockers and auto-merge status ([#216](https://github.com/alrayyes/forge-dashboard/issues/216)) ([41c3207](https://github.com/alrayyes/forge-dashboard/commit/41c3207d46fd0aff503bc596b9bc8068832f851a)), closes [#214](https://github.com/alrayyes/forge-dashboard/issues/214)
* **dashboard:** show which tracked repos have a confirmed webhook ([#236](https://github.com/alrayyes/forge-dashboard/issues/236)) ([f8e1557](https://github.com/alrayyes/forge-dashboard/commit/f8e155794ceb55b1d6420ae938457d1d7b116cc1))
* **dashboard:** unify filters across pull requests, issues, and Insights ([#211](https://github.com/alrayyes/forge-dashboard/issues/211)) ([79fde67](https://github.com/alrayyes/forge-dashboard/commit/79fde67493a58e796b13d24cdd147b38507f090c))
* **dashboard:** wire "Add a webhook" into a real API-backed button ([#255](https://github.com/alrayyes/forge-dashboard/issues/255)) ([7ae76b8](https://github.com/alrayyes/forge-dashboard/commit/7ae76b82b292ed1543f2a5ac300c3b045fd4ab64))
* exclude archived and forked repos from the dashboard ([#26](https://github.com/alrayyes/forge-dashboard/issues/26)) ([e1b8c58](https://github.com/alrayyes/forge-dashboard/commit/e1b8c58df8ab97480740696d0a2bdac5ead54689))
* filter pull requests and issues by forge ([#60](https://github.com/alrayyes/forge-dashboard/issues/60)) ([3d27935](https://github.com/alrayyes/forge-dashboard/commit/3d2793596dfa3ce4ac8ce410b95573b3869bb503)), closes [#37](https://github.com/alrayyes/forge-dashboard/issues/37)
* **footer:** add a Disclaimer and Privacy page ([#242](https://github.com/alrayyes/forge-dashboard/issues/242)) ([07ef7ba](https://github.com/alrayyes/forge-dashboard/commit/07ef7ba2fc2607de0f10eb312a163b9fee28682e))
* **forgejo:** support a token-free public-repos fallback ([#6](https://github.com/alrayyes/forge-dashboard/issues/6)) ([54fd0d6](https://github.com/alrayyes/forge-dashboard/commit/54fd0d6b47f7af38a4b795f6670cfc2db0a15a20))
* group pull requests and issues by repo ([#75](https://github.com/alrayyes/forge-dashboard/issues/75)) ([11227ba](https://github.com/alrayyes/forge-dashboard/commit/11227bac3fe85030b4598c6f6d0306441467a206)), closes [#39](https://github.com/alrayyes/forge-dashboard/issues/39)
* **insights:** add an Insights page with a CI status chart ([#184](https://github.com/alrayyes/forge-dashboard/issues/184)) ([c817e32](https://github.com/alrayyes/forge-dashboard/commit/c817e32308a2fede7ea4c74622e688f2f5f0887c))
* **insights:** histogram open issue age ([#199](https://github.com/alrayyes/forge-dashboard/issues/199)) ([6368613](https://github.com/alrayyes/forge-dashboard/commit/6368613aa4c5ba5fe1f869b19ac657d5582b02d7))
* **insights:** histogram open pull request age ([#191](https://github.com/alrayyes/forge-dashboard/issues/191)) ([0728420](https://github.com/alrayyes/forge-dashboard/commit/07284209513e926add371c037ceff6e9a088e039))
* **insights:** mirror the main dashboard's filters on the Insights page ([#207](https://github.com/alrayyes/forge-dashboard/issues/207)) ([bdaf5e3](https://github.com/alrayyes/forge-dashboard/commit/bdaf5e3d991ddb95bb0e9d1ffd12ef56eaf6d4f3))
* **insights:** rank repos by open pull request and issue count ([#187](https://github.com/alrayyes/forge-dashboard/issues/187)) ([512489e](https://github.com/alrayyes/forge-dashboard/commit/512489ea96d0beda1625d3c8a9d8acaedab100e3))
* **insights:** show each forge's API rate-limit headroom ([#195](https://github.com/alrayyes/forge-dashboard/issues/195)) ([fa0bd8e](https://github.com/alrayyes/forge-dashboard/commit/fa0bd8e4be98876c929450f59beab471d9bf58e5))
* keep repo/author/label filters and group-by consistent with the active forge ([#116](https://github.com/alrayyes/forge-dashboard/issues/116)) ([60bd346](https://github.com/alrayyes/forge-dashboard/commit/60bd3462a00ff0a8fbe91da8b4fe099d18b6e6de)), closes [#112](https://github.com/alrayyes/forge-dashboard/issues/112)
* let a user ignore a repo so its PRs/issues stop cluttering boards ([#393](https://github.com/alrayyes/forge-dashboard/issues/393)) ([06b9f70](https://github.com/alrayyes/forge-dashboard/commit/06b9f708763cbc071bc96e7d75667bd9105c8f2a)), closes [#363](https://github.com/alrayyes/forge-dashboard/issues/363)
* let a user set an expiration on personal API tokens ([#394](https://github.com/alrayyes/forge-dashboard/issues/394)) ([03ab7c5](https://github.com/alrayyes/forge-dashboard/commit/03ab7c5b7a64b14d60989ede3015b2803be8b747)), closes [#356](https://github.com/alrayyes/forge-dashboard/issues/356)
* make the repo filter a combobox of repos actually on screen ([#61](https://github.com/alrayyes/forge-dashboard/issues/61)) ([80e6502](https://github.com/alrayyes/forge-dashboard/commit/80e65029088b7c73bc70e58ff93a8cb46c24657c)), closes [#35](https://github.com/alrayyes/forge-dashboard/issues/35)
* move theme toggle to Settings, persist server-side ([#352](https://github.com/alrayyes/forge-dashboard/issues/352)) ([#400](https://github.com/alrayyes/forge-dashboard/issues/400)) ([03f623f](https://github.com/alrayyes/forge-dashboard/commit/03f623f7e7abffa7d26de0e81d0daf2b30dd21fc))
* on-demand refresh and subscription on Aggregator/Manager ([#79](https://github.com/alrayyes/forge-dashboard/issues/79)) ([9d73d3d](https://github.com/alrayyes/forge-dashboard/commit/9d73d3d955777ef8ad95cd5d8df93b0d88b3c36e))
* paginate pull request and issue lists ([#72](https://github.com/alrayyes/forge-dashboard/issues/72)) ([7db300a](https://github.com/alrayyes/forge-dashboard/commit/7db300a3ea73d38e4e6bc27ddf36ffe99a424c3e))
* passkey login gates the dashboard ([#9](https://github.com/alrayyes/forge-dashboard/issues/9)) ([0127736](https://github.com/alrayyes/forge-dashboard/commit/012773608b192fbf38bed2cadc585388b2b78bb1))
* per-user GitHub/Forgejo tokens ([#12](https://github.com/alrayyes/forge-dashboard/issues/12)) ([af6bdef](https://github.com/alrayyes/forge-dashboard/commit/af6bdef0ef4930d117543f9d24870cf587de72f6))
* persist dashboard/Insights filter state server-side ([#396](https://github.com/alrayyes/forge-dashboard/issues/396)) ([be060d0](https://github.com/alrayyes/forge-dashboard/commit/be060d02efc385262122874577790c525ba96276))
* persist theme and per-column filters via a cookie ([#114](https://github.com/alrayyes/forge-dashboard/issues/114)) ([1b6b51a](https://github.com/alrayyes/forge-dashboard/commit/1b6b51acd3bf5e5b6817107f3451532e2f680717)), closes [#111](https://github.com/alrayyes/forge-dashboard/issues/111)
* push dashboard updates over Server-Sent Events ([#88](https://github.com/alrayyes/forge-dashboard/issues/88)) ([cf3017c](https://github.com/alrayyes/forge-dashboard/commit/cf3017c4c97c6cf3f1fc2581d2d5b6d6c224fdab))
* receive and verify GitHub/Forgejo repository webhooks ([#86](https://github.com/alrayyes/forge-dashboard/issues/86)) ([9aed17f](https://github.com/alrayyes/forge-dashboard/commit/9aed17f7df91b250e3af879e31f265c8b98f84b7))
* render label colors on pull request and issue chips ([#77](https://github.com/alrayyes/forge-dashboard/issues/77)) ([a2412ca](https://github.com/alrayyes/forge-dashboard/commit/a2412caed5223c1b1b5e07f719b47cd0d56eebca)), closes [#42](https://github.com/alrayyes/forge-dashboard/issues/42)
* repo/author filters become selects, title gets autocomplete ([#103](https://github.com/alrayyes/forge-dashboard/issues/103)) ([52b2a5b](https://github.com/alrayyes/forge-dashboard/commit/52b2a5b9dd8f9f39281a04939f084a1bcbbe06c9)), closes [#101](https://github.com/alrayyes/forge-dashboard/issues/101)
* require a Forgejo URL alongside any Forgejo token or username ([#33](https://github.com/alrayyes/forge-dashboard/issues/33)) ([75ade23](https://github.com/alrayyes/forge-dashboard/commit/75ade234b681ad5c35b55d242f46ed8a513fc75d))
* **settings:** add toggle for allowing bot-managed PR branch updates ([f9c68a1](https://github.com/alrayyes/forge-dashboard/commit/f9c68a100df8967395818ad678fdec71c614ea77))
* **settings:** add toggle for allowing bot-managed PR branch updates ([d5003c0](https://github.com/alrayyes/forge-dashboard/commit/d5003c036506d7308326f3a8510392ec81e8f060)), closes [#330](https://github.com/alrayyes/forge-dashboard/issues/330)
* **settings:** move webhook coverage out of the main dashboard ([#261](https://github.com/alrayyes/forge-dashboard/issues/261)) ([d9bcaf8](https://github.com/alrayyes/forge-dashboard/commit/d9bcaf8b34e2fd1588913e88fd5a3d447a0b72f0))
* **settings:** per-user webhook credentials ([#81](https://github.com/alrayyes/forge-dashboard/issues/81)) ([22e8c4f](https://github.com/alrayyes/forge-dashboard/commit/22e8c4f7799216c47321faafa60e114cb89cc2c1))
* show each forge's API rate-limit budget on the dashboard ([#136](https://github.com/alrayyes/forge-dashboard/issues/136)) ([747d797](https://github.com/alrayyes/forge-dashboard/commit/747d7971db0e25fc69ad9b2a729cfd5548fe2ac6))
* show the running version in the footer, linked to its release ([#50](https://github.com/alrayyes/forge-dashboard/issues/50)) ([69d6e12](https://github.com/alrayyes/forge-dashboard/commit/69d6e12301160d0a0c0f23704111bbbe1cce4126))
* show/hide toggle for the token fields on Settings ([#58](https://github.com/alrayyes/forge-dashboard/issues/58)) ([388f05e](https://github.com/alrayyes/forge-dashboard/commit/388f05e50042016d88634cc14743537ee8cd520f)), closes [#44](https://github.com/alrayyes/forge-dashboard/issues/44)
* support multiple named passkeys per account ([#395](https://github.com/alrayyes/forge-dashboard/issues/395)) ([6afe834](https://github.com/alrayyes/forge-dashboard/commit/6afe83464fa8ea067162d30eb259f674ef0455a7)), closes [#355](https://github.com/alrayyes/forge-dashboard/issues/355)
* surface the real reason a forge is unreachable ([#128](https://github.com/alrayyes/forge-dashboard/issues/128)) ([69801fd](https://github.com/alrayyes/forge-dashboard/commit/69801fd679fc280bfc484b50c4a4e6ec6282b51f)), closes [#127](https://github.com/alrayyes/forge-dashboard/issues/127)
* switch the GitHub client to GraphQL ([#139](https://github.com/alrayyes/forge-dashboard/issues/139)) ([8a36c08](https://github.com/alrayyes/forge-dashboard/commit/8a36c08d0547586566570450ac32d541fe13c109)), closes [#138](https://github.com/alrayyes/forge-dashboard/issues/138)
* token creation guidance and required permissions on Settings ([#32](https://github.com/alrayyes/forge-dashboard/issues/32)) ([903146f](https://github.com/alrayyes/forge-dashboard/commit/903146f09cf1e7bcfa1736992629c9b4e2d2bcda)), closes [#29](https://github.com/alrayyes/forge-dashboard/issues/29)
* v1 forge dashboard ([#2](https://github.com/alrayyes/forge-dashboard/issues/2)) ([a6fa3c8](https://github.com/alrayyes/forge-dashboard/commit/a6fa3c8fc2a6da0ee025b251836c6e8c838cfe29))
* **web:** add a Merge button to mergeable pull request rows ([#302](https://github.com/alrayyes/forge-dashboard/issues/302)) ([96bdfef](https://github.com/alrayyes/forge-dashboard/commit/96bdfef715b1e77d6c69a30d4695195bbf8adb89)), closes [#299](https://github.com/alrayyes/forge-dashboard/issues/299)
* **web:** add an Update branch button to pull requests behind base ([#306](https://github.com/alrayyes/forge-dashboard/issues/306)) ([040f069](https://github.com/alrayyes/forge-dashboard/commit/040f0690abf761737693bce90598b5fd15507f24)), closes [#300](https://github.com/alrayyes/forge-dashboard/issues/300)
* **web:** don't offer a doomed "Add a webhook" click ([#295](https://github.com/alrayyes/forge-dashboard/issues/295)) ([365bcae](https://github.com/alrayyes/forge-dashboard/commit/365bcaef9d1f9e8cdac622048e85352349103b0f)), closes [#289](https://github.com/alrayyes/forge-dashboard/issues/289)
* **web:** explain permission-denied repos on Webhooks, migrate the page to SvelteKit ([e390f01](https://github.com/alrayyes/forge-dashboard/commit/e390f01524274074ac4c51d16a03e5b41b475083))
* **web:** explain permission-denied repos on Webhooks, migrate the page to SvelteKit ([75763ba](https://github.com/alrayyes/forge-dashboard/commit/75763ba08679528d957c8516f35b77e03443d918)), closes [#325](https://github.com/alrayyes/forge-dashboard/issues/325)
* **web:** hide Update branch on bot-managed PRs unless overridden ([a30ec36](https://github.com/alrayyes/forge-dashboard/commit/a30ec360b5014842a3b7e7408c936e9aab8b5163))
* **web:** hide Update branch on bot-managed PRs unless overridden ([475a336](https://github.com/alrayyes/forge-dashboard/commit/475a3364007d3a796fb7cb989448f7eecaa748c8)), closes [#331](https://github.com/alrayyes/forge-dashboard/issues/331)
* **webhooks:** log every incoming delivery and its outcome ([#166](https://github.com/alrayyes/forge-dashboard/issues/166)) ([3867c16](https://github.com/alrayyes/forge-dashboard/commit/3867c16a66a5ce5db60ed00dd4e94c1cc9b3b8f9))
* **webhooks:** scope a webhook-triggered refresh to the repo it names ([#158](https://github.com/alrayyes/forge-dashboard/issues/158)) ([940b3f2](https://github.com/alrayyes/forge-dashboard/commit/940b3f24b7b0f2f0d068ae942d7840721536115a))
* **web:** migrate the Settings page to SvelteKit ([#370](https://github.com/alrayyes/forge-dashboard/issues/370)) ([396c2c0](https://github.com/alrayyes/forge-dashboard/commit/396c2c0f4b24fe9daee9ef9fea4ea62bbce3769d)), closes [#334](https://github.com/alrayyes/forge-dashboard/issues/334)
* **web:** pre-emptively lock Merge/Update branch before a doomed click ([f70c417](https://github.com/alrayyes/forge-dashboard/commit/f70c417487f05b06494439999b10bf9b35ccd2ce))
* **web:** pre-emptively lock Merge/Update branch before a doomed click ([b7b9cda](https://github.com/alrayyes/forge-dashboard/commit/b7b9cdaf10d2d45b1dfe767450fc67a320106721)), closes [#319](https://github.com/alrayyes/forge-dashboard/issues/319)
* whoever registers first becomes admin ([#24](https://github.com/alrayyes/forge-dashboard/issues/24)) ([6452e3a](https://github.com/alrayyes/forge-dashboard/commit/6452e3a3b0c2e940e9c92965b406ba8c42e0d515))


### Bug Fixes

* add a label filter select, so an active filter is always clearable ([#108](https://github.com/alrayyes/forge-dashboard/issues/108)) ([6a5dfbb](https://github.com/alrayyes/forge-dashboard/commit/6a5dfbb1ad4d42a301e7ef9e7513f0171bfa77c8)), closes [#107](https://github.com/alrayyes/forge-dashboard/issues/107)
* add missing footer to settings, admin, and login pages ([#30](https://github.com/alrayyes/forge-dashboard/issues/30)) ([491e63e](https://github.com/alrayyes/forge-dashboard/commit/491e63ee12dbd27ed999e6399303af1e2cba1ed4)), closes [#28](https://github.com/alrayyes/forge-dashboard/issues/28)
* admin user table needing horizontal scroll at phone width ([#47](https://github.com/alrayyes/forge-dashboard/issues/47)) ([f016d98](https://github.com/alrayyes/forge-dashboard/commit/f016d986506fa899cd36a33a241628ceb35b4734))
* dark mode not respected outside the dashboard ([#57](https://github.com/alrayyes/forge-dashboard/issues/57)) ([907a2d9](https://github.com/alrayyes/forge-dashboard/commit/907a2d94d267bd81904f28bc5e27973bc9c00d63))
* dark-mode logo rendering as a blank tile ([#23](https://github.com/alrayyes/forge-dashboard/issues/23)) ([7933cb9](https://github.com/alrayyes/forge-dashboard/commit/7933cb90a03cfd6f07283fdcc6d56cf5e38256d3))
* darken the Forgejo forge badge for WCAG AA contrast in light theme ([#257](https://github.com/alrayyes/forge-dashboard/issues/257)) ([8c1487c](https://github.com/alrayyes/forge-dashboard/commit/8c1487cec57990cededbbadfc01a326c4027b118))
* **dashboard:** stat tiles reflect the active filter, not just the total ([#222](https://github.com/alrayyes/forge-dashboard/issues/222)) ([e376c8e](https://github.com/alrayyes/forge-dashboard/commit/e376c8edab3df7c45e4330da77c8f7e701a57d43)), closes [#221](https://github.com/alrayyes/forge-dashboard/issues/221)
* dedupe concurrent refresh triggers for the same user ([#148](https://github.com/alrayyes/forge-dashboard/issues/148)) ([c84d7e6](https://github.com/alrayyes/forge-dashboard/commit/c84d7e66d0c9a5e0135336718fcf4d83ee6a25b7))
* **deps:** bump github.com/moby/go-archive from 0.2.0 to 0.3.0 ([#5](https://github.com/alrayyes/forge-dashboard/issues/5)) ([aa91711](https://github.com/alrayyes/forge-dashboard/commit/aa917112c50eb4a1ff83ba02ac7edb8265272774))
* **docker:** exclude nested node_modules from the build context ([60d16a8](https://github.com/alrayyes/forge-dashboard/commit/60d16a8826231b2e7c9faf6c33445f0340004fe0))
* **docs:** resolve pre-existing Vale/LTeX prose-lint conflict ([#402](https://github.com/alrayyes/forge-dashboard/issues/402)) ([21731de](https://github.com/alrayyes/forge-dashboard/commit/21731deaaf3804824f8f19e465f52d18b43f98e3))
* exclude Forgejo mirror repos from polling ([#125](https://github.com/alrayyes/forge-dashboard/issues/125)) ([1c379b8](https://github.com/alrayyes/forge-dashboard/commit/1c379b8cae2581441248a745de4657b23214340b)), closes [#124](https://github.com/alrayyes/forge-dashboard/issues/124)
* **github:** apply the token to the REST client used for webhooks ([#280](https://github.com/alrayyes/forge-dashboard/issues/280)) ([f609f8d](https://github.com/alrayyes/forge-dashboard/commit/f609f8dd2d99635923291964082389dab06c1039))
* **github:** classify EnsureWebhook errors as dashboard.ClientError ([#287](https://github.com/alrayyes/forge-dashboard/issues/287)) ([f126a13](https://github.com/alrayyes/forge-dashboard/commit/f126a13be0ea052008e399f303d9203f6516c26d))
* give action buttons a real border, not a pill shape ([#383](https://github.com/alrayyes/forge-dashboard/issues/383)) ([1098d33](https://github.com/alrayyes/forge-dashboard/commit/1098d3323413f259b9242e4bffd20c0558a9b5e7)), closes [#358](https://github.com/alrayyes/forge-dashboard/issues/358)
* lazily rewarm a user's dashboard after a process restart ([#93](https://github.com/alrayyes/forge-dashboard/issues/93)) ([f2b21e2](https://github.com/alrayyes/forge-dashboard/commit/f2b21e2d7b5aa6a7c92fddcb763b8b88d7a5b865))
* let a username reclaim an abandoned registration ([#11](https://github.com/alrayyes/forge-dashboard/issues/11)) ([880b702](https://github.com/alrayyes/forge-dashboard/commit/880b702280e19ee403122ff4ea1b84753fcece65))
* long titles with several label chips collapsing to single-word lines ([#46](https://github.com/alrayyes/forge-dashboard/issues/46)) ([800fc3e](https://github.com/alrayyes/forge-dashboard/commit/800fc3e6efb6db8d92a99e05a9352a1c160aad3e))
* make GitHub merges respect the repo's allowed merge methods ([#376](https://github.com/alrayyes/forge-dashboard/issues/376)) ([2995195](https://github.com/alrayyes/forge-dashboard/commit/2995195edfb3865c710d061799d1542a79579fde)), closes [#349](https://github.com/alrayyes/forge-dashboard/issues/349)
* merge/update-branch lock state self-clears on a fresh poll ([#386](https://github.com/alrayyes/forge-dashboard/issues/386)) ([cf43a48](https://github.com/alrayyes/forge-dashboard/commit/cf43a48a87df7411b05f74c1ce659cc457b9c43f)), closes [#351](https://github.com/alrayyes/forge-dashboard/issues/351)
* only style the CI failing tile red once something is failing ([#140](https://github.com/alrayyes/forge-dashboard/issues/140)) ([c271c04](https://github.com/alrayyes/forge-dashboard/commit/c271c046fd7448e138b459512fea125a35f557a3))
* pin bun below 1.4 so Dependabot's bun updater stops corrupting the lockfile ([#98](https://github.com/alrayyes/forge-dashboard/issues/98)) ([14958c4](https://github.com/alrayyes/forge-dashboard/commit/14958c432e28ce4377c8ebd3dd54191d944b5101)), closes [#95](https://github.com/alrayyes/forge-dashboard/issues/95)
* query newest open issues and pull requests first ([#168](https://github.com/alrayyes/forge-dashboard/issues/168)) ([c7846c3](https://github.com/alrayyes/forge-dashboard/commit/c7846c31edded86810d72c47c992645a750c45e8))
* remove duplicate CHANGELOG entries for v0.66.0 and v0.67.0 ([c4d3eee](https://github.com/alrayyes/forge-dashboard/commit/c4d3eee50e94bc6d97f758fd2cfb5224cdf2e521)), closes [#342](https://github.com/alrayyes/forge-dashboard/issues/342)
* remove duplicate CHANGELOG entries for v0.68.0 ([#368](https://github.com/alrayyes/forge-dashboard/issues/368)) ([d5e87ba](https://github.com/alrayyes/forge-dashboard/commit/d5e87ba7c3943dc7fbe798d5e9e3542908fdfdba)), closes [#342](https://github.com/alrayyes/forge-dashboard/issues/342)
* remove duplicate CHANGELOG entries, fix local docker-build node_modules bug ([afef530](https://github.com/alrayyes/forge-dashboard/commit/afef53078e78712dde23aebb22f8b405b92a734e))
* report the rate-limit budget even on a failed request ([#143](https://github.com/alrayyes/forge-dashboard/issues/143)) ([c0a2dea](https://github.com/alrayyes/forge-dashboard/commit/c0a2deae0d7237330b80a7d86beb42f7de3bb34d)), closes [#142](https://github.com/alrayyes/forge-dashboard/issues/142)
* run a webhook-triggered refresh detached from the request ([#135](https://github.com/alrayyes/forge-dashboard/issues/135)) ([582eda0](https://github.com/alrayyes/forge-dashboard/commit/582eda0a176be752267b94ba6bbd35ae2df370df)), closes [#134](https://github.com/alrayyes/forge-dashboard/issues/134)
* run the SvelteKit build step before goreleaser's Go build ([#375](https://github.com/alrayyes/forge-dashboard/issues/375)) ([c41ecf9](https://github.com/alrayyes/forge-dashboard/commit/c41ecf92404d7af5ecdca2af71fca7b2e66f2a6c)), closes [#348](https://github.com/alrayyes/forge-dashboard/issues/348)
* set a busy_timeout on the SQLite connection ([#83](https://github.com/alrayyes/forge-dashboard/issues/83)) ([b8d2d09](https://github.com/alrayyes/forge-dashboard/commit/b8d2d09e2a5c3ae1226c8a7165b1739003d7f0c1)), closes [#82](https://github.com/alrayyes/forge-dashboard/issues/82)
* shorten and report rate limit for GraphQL-errors-array case too ([#149](https://github.com/alrayyes/forge-dashboard/issues/149)) ([504fed6](https://github.com/alrayyes/forge-dashboard/commit/504fed65c38512efecd09059a95592d1b1e5e481)), closes [#142](https://github.com/alrayyes/forge-dashboard/issues/142)
* show the real forge message for a merge's 409, not a guess ([#379](https://github.com/alrayyes/forge-dashboard/issues/379)) ([270be23](https://github.com/alrayyes/forge-dashboard/commit/270be236b2645a50968782d8e140df6bf7d5dfca)), closes [#350](https://github.com/alrayyes/forge-dashboard/issues/350)
* sort pull requests and issues by most recently updated ([#163](https://github.com/alrayyes/forge-dashboard/issues/163)) ([3d4f71b](https://github.com/alrayyes/forge-dashboard/commit/3d4f71bf447a8a5ffb1f45805dcaa0ca867f0d62))
* stop double-reporting a behind PR as also Blocked ([#388](https://github.com/alrayyes/forge-dashboard/issues/388)) ([27b2401](https://github.com/alrayyes/forge-dashboard/commit/27b2401c12d7218165e356914af6c0f47a333322)), closes [#359](https://github.com/alrayyes/forge-dashboard/issues/359)
* stop gitleaks flagging the e2e job's throwaway ENCRYPTION_KEY ([#17](https://github.com/alrayyes/forge-dashboard/issues/17)) ([780802f](https://github.com/alrayyes/forge-dashboard/commit/780802f3bd5ae01199ca9be4135c1598fac76dc2))
* stop repeating forge-wide errors per row, stop leaking raw ones ([#392](https://github.com/alrayyes/forge-dashboard/issues/392)) ([cc3e729](https://github.com/alrayyes/forge-dashboard/commit/cc3e729e45fa933e39c01360f0f447272f276591)), closes [#360](https://github.com/alrayyes/forge-dashboard/issues/360)
* stop the README screenshots from leaking a real name and repos ([#252](https://github.com/alrayyes/forge-dashboard/issues/252)) ([0f6b009](https://github.com/alrayyes/forge-dashboard/commit/0f6b0096a82714664cf8a7e3705efe371803da0f))
* style the "CI failing" tile green, not black, when zero in dark mode ([#173](https://github.com/alrayyes/forge-dashboard/issues/173)) ([1db2e98](https://github.com/alrayyes/forge-dashboard/commit/1db2e989cd74fdac64c693c94229d8cf0fff830b))
* **tests:** stop racing page.goto against its own waitForResponse ([#274](https://github.com/alrayyes/forge-dashboard/issues/274)) ([608dc94](https://github.com/alrayyes/forge-dashboard/commit/608dc94c490c91628ea7f61fc74f199f9d27f341)), closes [#273](https://github.com/alrayyes/forge-dashboard/issues/273)
* **web:** darken --warning so it clears WCAG AA contrast on its own bg ([#311](https://github.com/alrayyes/forge-dashboard/issues/311)) ([1e12997](https://github.com/alrayyes/forge-dashboard/commit/1e12997afc04c6178a53196ac26bbd3a47377e9b)), closes [#305](https://github.com/alrayyes/forge-dashboard/issues/305)
* **web:** make the merge button's confirm step and outcome visible ([#310](https://github.com/alrayyes/forge-dashboard/issues/310)) ([723d07f](https://github.com/alrayyes/forge-dashboard/commit/723d07fc73b1c076ff5c48da9a12c3a429e73c8f)), closes [#308](https://github.com/alrayyes/forge-dashboard/issues/308)
* **web:** remove the home page's duplicate rate-limit chip ([#294](https://github.com/alrayyes/forge-dashboard/issues/294)) ([8884bc7](https://github.com/alrayyes/forge-dashboard/commit/8884bc78c2a98053b52c4709c6b3fa1207e73004)), closes [#292](https://github.com/alrayyes/forge-dashboard/issues/292)
* wire the theme toggle button on every page, not just the dashboard ([2485e98](https://github.com/alrayyes/forge-dashboard/commit/2485e985b20fe81203ff4f8e74f5d44b3e5f4edb))
* wire the theme toggle button on every page, not just the dashboard ([3b26156](https://github.com/alrayyes/forge-dashboard/commit/3b26156714063d7f0e347bdc0a5caf67d2feeb3e)), closes [#327](https://github.com/alrayyes/forge-dashboard/issues/327)

## [0.72.0](https://github.com/alrayyes/forge-dashboard/compare/v0.71.0...v0.72.0) (2026-09-18)


### Features

* add a Clear filters button to the shared filter bar ([#389](https://github.com/alrayyes/forge-dashboard/issues/389)) ([e0d4fbd](https://github.com/alrayyes/forge-dashboard/commit/e0d4fbdd4bbdb6d8ce689b85f037d10b1035131d)), closes [#354](https://github.com/alrayyes/forge-dashboard/issues/354)
* let a user set an expiration on personal API tokens ([#394](https://github.com/alrayyes/forge-dashboard/issues/394)) ([03ab7c5](https://github.com/alrayyes/forge-dashboard/commit/03ab7c5b7a64b14d60989ede3015b2803be8b747)), closes [#356](https://github.com/alrayyes/forge-dashboard/issues/356)
* move theme toggle to Settings, persist server-side ([#352](https://github.com/alrayyes/forge-dashboard/issues/352)) ([#400](https://github.com/alrayyes/forge-dashboard/issues/400)) ([03f623f](https://github.com/alrayyes/forge-dashboard/commit/03f623f7e7abffa7d26de0e81d0daf2b30dd21fc))

## [0.71.0](https://github.com/alrayyes/forge-dashboard/compare/v0.70.3...v0.71.0) (2026-09-18)


### Features

* persist dashboard/Insights filter state server-side ([#396](https://github.com/alrayyes/forge-dashboard/issues/396)) ([be060d0](https://github.com/alrayyes/forge-dashboard/commit/be060d02efc385262122874577790c525ba96276))

## [0.70.3](https://github.com/alrayyes/forge-dashboard/compare/v0.70.2...v0.70.3) (2026-09-18)


### Bug Fixes

* give action buttons a real border, not a pill shape ([#383](https://github.com/alrayyes/forge-dashboard/issues/383)) ([1098d33](https://github.com/alrayyes/forge-dashboard/commit/1098d3323413f259b9242e4bffd20c0558a9b5e7)), closes [#358](https://github.com/alrayyes/forge-dashboard/issues/358)
* merge/update-branch lock state self-clears on a fresh poll ([#386](https://github.com/alrayyes/forge-dashboard/issues/386)) ([cf43a48](https://github.com/alrayyes/forge-dashboard/commit/cf43a48a87df7411b05f74c1ce659cc457b9c43f)), closes [#351](https://github.com/alrayyes/forge-dashboard/issues/351)

## [0.70.2](https://github.com/alrayyes/forge-dashboard/compare/v0.70.1...v0.70.2) (2026-09-18)


### Bug Fixes

* make GitHub merges respect the repo's allowed merge methods ([#376](https://github.com/alrayyes/forge-dashboard/issues/376)) ([2995195](https://github.com/alrayyes/forge-dashboard/commit/2995195edfb3865c710d061799d1542a79579fde)), closes [#349](https://github.com/alrayyes/forge-dashboard/issues/349)
* show the real forge message for a merge's 409, not a guess ([#379](https://github.com/alrayyes/forge-dashboard/issues/379)) ([270be23](https://github.com/alrayyes/forge-dashboard/commit/270be236b2645a50968782d8e140df6bf7d5dfca)), closes [#350](https://github.com/alrayyes/forge-dashboard/issues/350)

## [0.70.1](https://github.com/alrayyes/forge-dashboard/compare/v0.70.0...v0.70.1) (2026-09-18)


### Bug Fixes

* run the SvelteKit build step before goreleaser's Go build ([#375](https://github.com/alrayyes/forge-dashboard/issues/375)) ([c41ecf9](https://github.com/alrayyes/forge-dashboard/commit/c41ecf92404d7af5ecdca2af71fca7b2e66f2a6c)), closes [#348](https://github.com/alrayyes/forge-dashboard/issues/348)

## [0.70.0](https://github.com/alrayyes/forge-dashboard/compare/v0.69.1...v0.70.0) (2026-09-18)


### Features

* **web:** migrate the Settings page to SvelteKit ([#370](https://github.com/alrayyes/forge-dashboard/issues/370)) ([396c2c0](https://github.com/alrayyes/forge-dashboard/commit/396c2c0f4b24fe9daee9ef9fea4ea62bbce3769d)), closes [#334](https://github.com/alrayyes/forge-dashboard/issues/334)

## [0.69.1](https://github.com/alrayyes/forge-dashboard/compare/v0.69.0...v0.69.1) (2026-09-18)


### Bug Fixes

* remove duplicate CHANGELOG entries for v0.68.0 ([#368](https://github.com/alrayyes/forge-dashboard/issues/368)) ([d5e87ba](https://github.com/alrayyes/forge-dashboard/commit/d5e87ba7c3943dc7fbe798d5e9e3542908fdfdba)), closes [#342](https://github.com/alrayyes/forge-dashboard/issues/342)

## [0.69.0](https://github.com/alrayyes/forge-dashboard/compare/v0.68.0...v0.69.0) (2026-09-18)


### Features

* add a Renovate rebase button to pull request rows ([7f3d9aa](https://github.com/alrayyes/forge-dashboard/commit/7f3d9aad8b161dd0eaf54aaaf0faa62aada3da3d))

## [0.68.0](https://github.com/alrayyes/forge-dashboard/compare/v0.67.1...v0.68.0) (2026-09-18)


### Features

* add Dependabot rebase/recreate buttons to pull request rows ([bee0b7c](https://github.com/alrayyes/forge-dashboard/commit/bee0b7c7e5ef0240f12c9a45936087acdd02b05c)), closes [#332](https://github.com/alrayyes/forge-dashboard/issues/332)


### Bug Fixes

* wire the theme toggle button on every page, not just the dashboard ([3b26156](https://github.com/alrayyes/forge-dashboard/commit/3b26156714063d7f0e347bdc0a5caf67d2feeb3e)), closes [#327](https://github.com/alrayyes/forge-dashboard/issues/327)

## [0.67.1](https://github.com/alrayyes/forge-dashboard/compare/v0.67.0...v0.67.1) (2026-09-17)


### Bug Fixes

* **docker:** exclude nested node_modules from the build context ([60d16a8](https://github.com/alrayyes/forge-dashboard/commit/60d16a8826231b2e7c9faf6c33445f0340004fe0))
* remove duplicate CHANGELOG entries for v0.66.0 and v0.67.0 ([c4d3eee](https://github.com/alrayyes/forge-dashboard/commit/c4d3eee50e94bc6d97f758fd2cfb5224cdf2e521)), closes [#342](https://github.com/alrayyes/forge-dashboard/issues/342)
* remove duplicate CHANGELOG entries, fix local docker-build node_modules bug ([afef530](https://github.com/alrayyes/forge-dashboard/commit/afef53078e78712dde23aebb22f8b405b92a734e))

## [0.67.0](https://github.com/alrayyes/forge-dashboard/compare/v0.66.0...v0.67.0) (2026-09-17)


### Features

* **web:** hide Update branch on bot-managed PRs unless overridden ([475a336](https://github.com/alrayyes/forge-dashboard/commit/475a3364007d3a796fb7cb989448f7eecaa748c8)), closes [#331](https://github.com/alrayyes/forge-dashboard/issues/331)

## [0.66.0](https://github.com/alrayyes/forge-dashboard/compare/v0.65.0...v0.66.0) (2026-09-17)


### Features

* **settings:** add toggle for allowing bot-managed PR branch updates ([d5003c0](https://github.com/alrayyes/forge-dashboard/commit/d5003c036506d7308326f3a8510392ec81e8f060)), closes [#330](https://github.com/alrayyes/forge-dashboard/issues/330)
* **web:** explain permission-denied repos on Webhooks, migrate the page to SvelteKit ([75763ba](https://github.com/alrayyes/forge-dashboard/commit/75763ba08679528d957c8516f35b77e03443d918)), closes [#325](https://github.com/alrayyes/forge-dashboard/issues/325)

## [0.65.0](https://github.com/alrayyes/forge-dashboard/compare/v0.64.0...v0.65.0) (2026-09-17)


### Features

* **web:** pre-emptively lock Merge/Update branch before a doomed click ([f70c417](https://github.com/alrayyes/forge-dashboard/commit/f70c417487f05b06494439999b10bf9b35ccd2ce))
* **web:** pre-emptively lock Merge/Update branch before a doomed click ([b7b9cda](https://github.com/alrayyes/forge-dashboard/commit/b7b9cdaf10d2d45b1dfe767450fc67a320106721)), closes [#319](https://github.com/alrayyes/forge-dashboard/issues/319)

## [0.64.0](https://github.com/alrayyes/forge-dashboard/compare/v0.63.2...v0.64.0) (2026-09-17)


### Features

* **auth:** add personal API tokens alongside passkey sessions ([#316](https://github.com/alrayyes/forge-dashboard/issues/316)) ([3968284](https://github.com/alrayyes/forge-dashboard/commit/396828429abe7d5feb90861b20e98d54b835d26b)), closes [#301](https://github.com/alrayyes/forge-dashboard/issues/301)

## [0.63.2](https://github.com/alrayyes/forge-dashboard/compare/v0.63.1...v0.63.2) (2026-09-17)


### Bug Fixes

* **web:** darken --warning so it clears WCAG AA contrast on its own bg ([#311](https://github.com/alrayyes/forge-dashboard/issues/311)) ([1e12997](https://github.com/alrayyes/forge-dashboard/commit/1e12997afc04c6178a53196ac26bbd3a47377e9b)), closes [#305](https://github.com/alrayyes/forge-dashboard/issues/305)

## [0.63.1](https://github.com/alrayyes/forge-dashboard/compare/v0.63.0...v0.63.1) (2026-09-17)


### Bug Fixes

* **web:** make the merge button's confirm step and outcome visible ([#310](https://github.com/alrayyes/forge-dashboard/issues/310)) ([723d07f](https://github.com/alrayyes/forge-dashboard/commit/723d07fc73b1c076ff5c48da9a12c3a429e73c8f)), closes [#308](https://github.com/alrayyes/forge-dashboard/issues/308)

## [0.63.0](https://github.com/alrayyes/forge-dashboard/compare/v0.62.0...v0.63.0) (2026-09-17)


### Features

* **web:** add an Update branch button to pull requests behind base ([#306](https://github.com/alrayyes/forge-dashboard/issues/306)) ([040f069](https://github.com/alrayyes/forge-dashboard/commit/040f0690abf761737693bce90598b5fd15507f24)), closes [#300](https://github.com/alrayyes/forge-dashboard/issues/300)

## [0.62.0](https://github.com/alrayyes/forge-dashboard/compare/v0.61.0...v0.62.0) (2026-09-17)


### Features

* **web:** add a Merge button to mergeable pull request rows ([#302](https://github.com/alrayyes/forge-dashboard/issues/302)) ([96bdfef](https://github.com/alrayyes/forge-dashboard/commit/96bdfef715b1e77d6c69a30d4695195bbf8adb89)), closes [#299](https://github.com/alrayyes/forge-dashboard/issues/299)

## [0.61.0](https://github.com/alrayyes/forge-dashboard/compare/v0.60.3...v0.61.0) (2026-09-17)


### Features

* **web:** don't offer a doomed "Add a webhook" click ([#295](https://github.com/alrayyes/forge-dashboard/issues/295)) ([365bcae](https://github.com/alrayyes/forge-dashboard/commit/365bcaef9d1f9e8cdac622048e85352349103b0f)), closes [#289](https://github.com/alrayyes/forge-dashboard/issues/289)

## [0.60.3](https://github.com/alrayyes/forge-dashboard/compare/v0.60.2...v0.60.3) (2026-09-17)


### Bug Fixes

* **web:** remove the home page's duplicate rate-limit chip ([#294](https://github.com/alrayyes/forge-dashboard/issues/294)) ([8884bc7](https://github.com/alrayyes/forge-dashboard/commit/8884bc78c2a98053b52c4709c6b3fa1207e73004)), closes [#292](https://github.com/alrayyes/forge-dashboard/issues/292)

## [0.60.2](https://github.com/alrayyes/forge-dashboard/compare/v0.60.1...v0.60.2) (2026-09-17)


### Bug Fixes

* **github:** classify EnsureWebhook errors as dashboard.ClientError ([#287](https://github.com/alrayyes/forge-dashboard/issues/287)) ([f126a13](https://github.com/alrayyes/forge-dashboard/commit/f126a13be0ea052008e399f303d9203f6516c26d))

## [0.60.1](https://github.com/alrayyes/forge-dashboard/compare/v0.60.0...v0.60.1) (2026-09-17)


### Bug Fixes

* **github:** apply the token to the REST client used for webhooks ([#280](https://github.com/alrayyes/forge-dashboard/issues/280)) ([f609f8d](https://github.com/alrayyes/forge-dashboard/commit/f609f8dd2d99635923291964082389dab06c1039))

## [0.60.0](https://github.com/alrayyes/forge-dashboard/compare/v0.59.1...v0.60.0) (2026-09-17)


### Features

* **dashboard:** make the brand logo/wordmark link to home ([#278](https://github.com/alrayyes/forge-dashboard/issues/278)) ([f845533](https://github.com/alrayyes/forge-dashboard/commit/f845533314c81d17cb5baedec218449f70a643b3)), closes [#277](https://github.com/alrayyes/forge-dashboard/issues/277)

## [0.59.1](https://github.com/alrayyes/forge-dashboard/compare/v0.59.0...v0.59.1) (2026-09-16)


### Bug Fixes

* **tests:** stop racing page.goto against its own waitForResponse ([#274](https://github.com/alrayyes/forge-dashboard/issues/274)) ([608dc94](https://github.com/alrayyes/forge-dashboard/commit/608dc94c490c91628ea7f61fc74f199f9d27f341)), closes [#273](https://github.com/alrayyes/forge-dashboard/issues/273)

## [0.59.0](https://github.com/alrayyes/forge-dashboard/compare/v0.58.0...v0.59.0) (2026-09-16)


### Features

* **dashboard:** add a persistent top nav, shared across every page ([#270](https://github.com/alrayyes/forge-dashboard/issues/270)) ([df308da](https://github.com/alrayyes/forge-dashboard/commit/df308da0b87bf6d99038536ff049fcd4072819bd)), closes [#269](https://github.com/alrayyes/forge-dashboard/issues/269)

## [0.58.0](https://github.com/alrayyes/forge-dashboard/compare/v0.57.0...v0.58.0) (2026-09-16)


### Features

* **dashboard:** add filters and sorting to the webhooks page ([#266](https://github.com/alrayyes/forge-dashboard/issues/266)) ([63f524e](https://github.com/alrayyes/forge-dashboard/commit/63f524e4bdcae434ecc937234e2fd1475adf8840))

## [0.57.0](https://github.com/alrayyes/forge-dashboard/compare/v0.56.1...v0.57.0) (2026-09-16)


### Features

* **settings:** move webhook coverage out of the main dashboard ([#261](https://github.com/alrayyes/forge-dashboard/issues/261)) ([d9bcaf8](https://github.com/alrayyes/forge-dashboard/commit/d9bcaf8b34e2fd1588913e88fd5a3d447a0b72f0))

## [0.56.1](https://github.com/alrayyes/forge-dashboard/compare/v0.56.0...v0.56.1) (2026-09-16)


### Bug Fixes

* darken the Forgejo forge badge for WCAG AA contrast in light theme ([#257](https://github.com/alrayyes/forge-dashboard/issues/257)) ([8c1487c](https://github.com/alrayyes/forge-dashboard/commit/8c1487cec57990cededbbadfc01a326c4027b118))

## [0.56.0](https://github.com/alrayyes/forge-dashboard/compare/v0.55.1...v0.56.0) (2026-09-16)


### Features

* **dashboard:** wire "Add a webhook" into a real API-backed button ([#255](https://github.com/alrayyes/forge-dashboard/issues/255)) ([7ae76b8](https://github.com/alrayyes/forge-dashboard/commit/7ae76b82b292ed1543f2a5ac300c3b045fd4ab64))

## [0.55.1](https://github.com/alrayyes/forge-dashboard/compare/v0.55.0...v0.55.1) (2026-09-16)


### Bug Fixes

* stop the README screenshots from leaking a real name and repos ([#252](https://github.com/alrayyes/forge-dashboard/issues/252)) ([0f6b009](https://github.com/alrayyes/forge-dashboard/commit/0f6b0096a82714664cf8a7e3705efe371803da0f))

## [0.55.0](https://github.com/alrayyes/forge-dashboard/compare/v0.54.0...v0.55.0) (2026-09-16)


### Features

* **dashboard:** give webhook coverage its own paginated page ([#246](https://github.com/alrayyes/forge-dashboard/issues/246)) ([63e98cb](https://github.com/alrayyes/forge-dashboard/commit/63e98cba45df27c5444aebf4c601815e39e40f14))

## [0.54.0](https://github.com/alrayyes/forge-dashboard/compare/v0.53.0...v0.54.0) (2026-09-16)


### Features

* **dashboard:** check a repo's webhook via the forge API, ahead of the delivery table ([#243](https://github.com/alrayyes/forge-dashboard/issues/243)) ([3ddb094](https://github.com/alrayyes/forge-dashboard/commit/3ddb094b87b654637617ba2d632584f153613a10))
* **footer:** add a Disclaimer and Privacy page ([#242](https://github.com/alrayyes/forge-dashboard/issues/242)) ([07ef7ba](https://github.com/alrayyes/forge-dashboard/commit/07ef7ba2fc2607de0f10eb312a163b9fee28682e))

## [0.53.0](https://github.com/alrayyes/forge-dashboard/compare/v0.52.0...v0.53.0) (2026-09-16)


### Features

* **dashboard:** show which tracked repos have a confirmed webhook ([#236](https://github.com/alrayyes/forge-dashboard/issues/236)) ([f8e1557](https://github.com/alrayyes/forge-dashboard/commit/f8e155794ceb55b1d6420ae938457d1d7b116cc1))

## [0.52.0](https://github.com/alrayyes/forge-dashboard/compare/v0.51.0...v0.52.0) (2026-09-16)


### Features

* **dashboard:** classify unreachable-forge errors into actionable kinds ([#230](https://github.com/alrayyes/forge-dashboard/issues/230)) ([3f02b51](https://github.com/alrayyes/forge-dashboard/commit/3f02b51003f4d0205d8b7f16628964fbafdf5395))

## [0.51.0](https://github.com/alrayyes/forge-dashboard/compare/v0.50.1...v0.51.0) (2026-09-16)


### Features

* **dashboard:** add a force-refresh button ([#225](https://github.com/alrayyes/forge-dashboard/issues/225)) ([ecbd4c8](https://github.com/alrayyes/forge-dashboard/commit/ecbd4c84390660ce03dd74144b35db1364f4632d)), closes [#219](https://github.com/alrayyes/forge-dashboard/issues/219)

## [0.50.1](https://github.com/alrayyes/forge-dashboard/compare/v0.50.0...v0.50.1) (2026-09-16)


### Bug Fixes

* **dashboard:** stat tiles reflect the active filter, not just the total ([#222](https://github.com/alrayyes/forge-dashboard/issues/222)) ([e376c8e](https://github.com/alrayyes/forge-dashboard/commit/e376c8edab3df7c45e4330da77c8f7e701a57d43)), closes [#221](https://github.com/alrayyes/forge-dashboard/issues/221)

## [0.50.0](https://github.com/alrayyes/forge-dashboard/compare/v0.49.0...v0.50.0) (2026-09-16)


### Features

* **dashboard:** show merge conflicts/blockers and auto-merge status ([#216](https://github.com/alrayyes/forge-dashboard/issues/216)) ([41c3207](https://github.com/alrayyes/forge-dashboard/commit/41c3207d46fd0aff503bc596b9bc8068832f851a)), closes [#214](https://github.com/alrayyes/forge-dashboard/issues/214)

## [0.49.0](https://github.com/alrayyes/forge-dashboard/compare/v0.48.0...v0.49.0) (2026-09-16)


### Features

* **dashboard:** unify filters across pull requests, issues, and Insights ([#211](https://github.com/alrayyes/forge-dashboard/issues/211)) ([79fde67](https://github.com/alrayyes/forge-dashboard/commit/79fde67493a58e796b13d24cdd147b38507f090c))

## [0.48.0](https://github.com/alrayyes/forge-dashboard/compare/v0.47.0...v0.48.0) (2026-09-15)


### Features

* **insights:** mirror the main dashboard's filters on the Insights page ([#207](https://github.com/alrayyes/forge-dashboard/issues/207)) ([bdaf5e3](https://github.com/alrayyes/forge-dashboard/commit/bdaf5e3d991ddb95bb0e9d1ffd12ef56eaf6d4f3))

## [0.47.0](https://github.com/alrayyes/forge-dashboard/compare/v0.46.0...v0.47.0) (2026-09-15)


### Features

* **dashboard:** hide Renovate's Dependency Dashboard issue by default ([#203](https://github.com/alrayyes/forge-dashboard/issues/203)) ([57dd2fc](https://github.com/alrayyes/forge-dashboard/commit/57dd2fc1c3f57d31262d305c2031cd54e0583055))

## [0.46.0](https://github.com/alrayyes/forge-dashboard/compare/v0.45.0...v0.46.0) (2026-09-15)


### Features

* **insights:** histogram open issue age ([#199](https://github.com/alrayyes/forge-dashboard/issues/199)) ([6368613](https://github.com/alrayyes/forge-dashboard/commit/6368613aa4c5ba5fe1f869b19ac657d5582b02d7))

## [0.45.0](https://github.com/alrayyes/forge-dashboard/compare/v0.44.0...v0.45.0) (2026-09-15)


### Features

* **insights:** show each forge's API rate-limit headroom ([#195](https://github.com/alrayyes/forge-dashboard/issues/195)) ([fa0bd8e](https://github.com/alrayyes/forge-dashboard/commit/fa0bd8e4be98876c929450f59beab471d9bf58e5))

## [0.44.0](https://github.com/alrayyes/forge-dashboard/compare/v0.43.0...v0.44.0) (2026-09-15)


### Features

* **insights:** histogram open pull request age ([#191](https://github.com/alrayyes/forge-dashboard/issues/191)) ([0728420](https://github.com/alrayyes/forge-dashboard/commit/07284209513e926add371c037ceff6e9a088e039))

## [0.43.0](https://github.com/alrayyes/forge-dashboard/compare/v0.42.0...v0.43.0) (2026-09-15)


### Features

* **insights:** rank repos by open pull request and issue count ([#187](https://github.com/alrayyes/forge-dashboard/issues/187)) ([512489e](https://github.com/alrayyes/forge-dashboard/commit/512489ea96d0beda1625d3c8a9d8acaedab100e3))

## [0.42.0](https://github.com/alrayyes/forge-dashboard/compare/v0.41.2...v0.42.0) (2026-09-15)


### Features

* **insights:** add an Insights page with a CI status chart ([#184](https://github.com/alrayyes/forge-dashboard/issues/184)) ([c817e32](https://github.com/alrayyes/forge-dashboard/commit/c817e32308a2fede7ea4c74622e688f2f5f0887c))

## [0.41.2](https://github.com/alrayyes/forge-dashboard/compare/v0.41.1...v0.41.2) (2026-09-15)


### Bug Fixes

* style the "CI failing" tile green, not black, when zero in dark mode ([#173](https://github.com/alrayyes/forge-dashboard/issues/173)) ([1db2e98](https://github.com/alrayyes/forge-dashboard/commit/1db2e989cd74fdac64c693c94229d8cf0fff830b))

## [0.41.1](https://github.com/alrayyes/forge-dashboard/compare/v0.41.0...v0.41.1) (2026-09-15)


### Bug Fixes

* query newest open issues and pull requests first ([#168](https://github.com/alrayyes/forge-dashboard/issues/168)) ([c7846c3](https://github.com/alrayyes/forge-dashboard/commit/c7846c31edded86810d72c47c992645a750c45e8))

## [0.41.0](https://github.com/alrayyes/forge-dashboard/compare/v0.40.1...v0.41.0) (2026-09-15)


### Features

* **webhooks:** log every incoming delivery and its outcome ([#166](https://github.com/alrayyes/forge-dashboard/issues/166)) ([3867c16](https://github.com/alrayyes/forge-dashboard/commit/3867c16a66a5ce5db60ed00dd4e94c1cc9b3b8f9))

## [0.40.1](https://github.com/alrayyes/forge-dashboard/compare/v0.40.0...v0.40.1) (2026-09-15)


### Bug Fixes

* sort pull requests and issues by most recently updated ([#163](https://github.com/alrayyes/forge-dashboard/issues/163)) ([3d4f71b](https://github.com/alrayyes/forge-dashboard/commit/3d4f71bf447a8a5ffb1f45805dcaa0ca867f0d62))

## [0.40.0](https://github.com/alrayyes/forge-dashboard/compare/v0.39.0...v0.40.0) (2026-09-14)


### Features

* **webhooks:** scope a webhook-triggered refresh to the repo it names ([#158](https://github.com/alrayyes/forge-dashboard/issues/158)) ([940b3f2](https://github.com/alrayyes/forge-dashboard/commit/940b3f24b7b0f2f0d068ae942d7840721536115a))

## [0.39.0](https://github.com/alrayyes/forge-dashboard/compare/v0.38.1...v0.39.0) (2026-09-14)


### Features

* **dashboard:** add Aggregator/Manager.RefreshRepo for scoped refreshes ([#156](https://github.com/alrayyes/forge-dashboard/issues/156)) ([f9fa3df](https://github.com/alrayyes/forge-dashboard/commit/f9fa3df41d6db3a7384f704845793e72ce93f015))

## [0.38.1](https://github.com/alrayyes/forge-dashboard/compare/v0.38.0...v0.38.1) (2026-09-14)


### Bug Fixes

* dedupe concurrent refresh triggers for the same user ([#148](https://github.com/alrayyes/forge-dashboard/issues/148)) ([c84d7e6](https://github.com/alrayyes/forge-dashboard/commit/c84d7e66d0c9a5e0135336718fcf4d83ee6a25b7))

## [0.38.0](https://github.com/alrayyes/forge-dashboard/compare/v0.37.1...v0.38.0) (2026-09-14)


### Features

* add a LOG_LEVEL debug mode logging every outbound request ([#146](https://github.com/alrayyes/forge-dashboard/issues/146)) ([b668560](https://github.com/alrayyes/forge-dashboard/commit/b668560072fd4fed1738493b843210b1d1fdabf1)), closes [#145](https://github.com/alrayyes/forge-dashboard/issues/145)
* **dashboard:** add Forge() and RepoRefresher to the Source interface ([#150](https://github.com/alrayyes/forge-dashboard/issues/150)) ([5aef5e1](https://github.com/alrayyes/forge-dashboard/commit/5aef5e12e4699279156bf267d348ba8f4b12225c))


### Bug Fixes

* shorten and report rate limit for GraphQL-errors-array case too ([#149](https://github.com/alrayyes/forge-dashboard/issues/149)) ([504fed6](https://github.com/alrayyes/forge-dashboard/commit/504fed65c38512efecd09059a95592d1b1e5e481)), closes [#142](https://github.com/alrayyes/forge-dashboard/issues/142)

## [0.37.1](https://github.com/alrayyes/forge-dashboard/compare/v0.37.0...v0.37.1) (2026-09-14)


### Bug Fixes

* report the rate-limit budget even on a failed request ([#143](https://github.com/alrayyes/forge-dashboard/issues/143)) ([c0a2dea](https://github.com/alrayyes/forge-dashboard/commit/c0a2deae0d7237330b80a7d86beb42f7de3bb34d)), closes [#142](https://github.com/alrayyes/forge-dashboard/issues/142)

## [0.37.0](https://github.com/alrayyes/forge-dashboard/compare/v0.36.0...v0.37.0) (2026-09-14)


### Features

* switch the GitHub client to GraphQL ([#139](https://github.com/alrayyes/forge-dashboard/issues/139)) ([8a36c08](https://github.com/alrayyes/forge-dashboard/commit/8a36c08d0547586566570450ac32d541fe13c109)), closes [#138](https://github.com/alrayyes/forge-dashboard/issues/138)


### Bug Fixes

* only style the CI failing tile red once something is failing ([#140](https://github.com/alrayyes/forge-dashboard/issues/140)) ([c271c04](https://github.com/alrayyes/forge-dashboard/commit/c271c046fd7448e138b459512fea125a35f557a3))

## [0.36.0](https://github.com/alrayyes/forge-dashboard/compare/v0.35.0...v0.36.0) (2026-09-14)


### Features

* **api:** add a rate-limit schema to ForgeHealth ([#133](https://github.com/alrayyes/forge-dashboard/issues/133)) ([073e7f4](https://github.com/alrayyes/forge-dashboard/commit/073e7f4f308ce7544b5535d344d602c38f128538))
* show each forge's API rate-limit budget on the dashboard ([#136](https://github.com/alrayyes/forge-dashboard/issues/136)) ([747d797](https://github.com/alrayyes/forge-dashboard/commit/747d7971db0e25fc69ad9b2a729cfd5548fe2ac6))


### Bug Fixes

* run a webhook-triggered refresh detached from the request ([#135](https://github.com/alrayyes/forge-dashboard/issues/135)) ([582eda0](https://github.com/alrayyes/forge-dashboard/commit/582eda0a176be752267b94ba6bbd35ae2df370df)), closes [#134](https://github.com/alrayyes/forge-dashboard/issues/134)

## [0.35.0](https://github.com/alrayyes/forge-dashboard/compare/v0.34.0...v0.35.0) (2026-09-14)


### Features

* surface the real reason a forge is unreachable ([#128](https://github.com/alrayyes/forge-dashboard/issues/128)) ([69801fd](https://github.com/alrayyes/forge-dashboard/commit/69801fd679fc280bfc484b50c4a4e6ec6282b51f)), closes [#127](https://github.com/alrayyes/forge-dashboard/issues/127)

## [0.34.0](https://github.com/alrayyes/forge-dashboard/compare/v0.33.0...v0.34.0) (2026-09-14)


### Features

* add a copy button for the webhook secret ([#123](https://github.com/alrayyes/forge-dashboard/issues/123)) ([f2e4fb8](https://github.com/alrayyes/forge-dashboard/commit/f2e4fb8baf1877bc4df348290960588dfd16c101))


### Bug Fixes

* exclude Forgejo mirror repos from polling ([#125](https://github.com/alrayyes/forge-dashboard/issues/125)) ([1c379b8](https://github.com/alrayyes/forge-dashboard/commit/1c379b8cae2581441248a745de4657b23214340b)), closes [#124](https://github.com/alrayyes/forge-dashboard/issues/124)

## [0.33.0](https://github.com/alrayyes/forge-dashboard/compare/v0.32.0...v0.33.0) (2026-09-14)


### Features

* add a link to the repo in the footer ([#120](https://github.com/alrayyes/forge-dashboard/issues/120)) ([24e1b8d](https://github.com/alrayyes/forge-dashboard/commit/24e1b8d389bb8bc0699899428b58695c7284610d))

## [0.32.0](https://github.com/alrayyes/forge-dashboard/compare/v0.31.0...v0.32.0) (2026-09-14)


### Features

* add auto-updating README screenshots, refreshed on every release ([#118](https://github.com/alrayyes/forge-dashboard/issues/118)) ([4f74fe0](https://github.com/alrayyes/forge-dashboard/commit/4f74fe024d3d8c2aee574c66fa266f5c8e899dd0)), closes [#113](https://github.com/alrayyes/forge-dashboard/issues/113)

## [0.31.0](https://github.com/alrayyes/forge-dashboard/compare/v0.30.0...v0.31.0) (2026-09-14)


### Features

* keep repo/author/label filters and group-by consistent with the active forge ([#116](https://github.com/alrayyes/forge-dashboard/issues/116)) ([60bd346](https://github.com/alrayyes/forge-dashboard/commit/60bd3462a00ff0a8fbe91da8b4fe099d18b6e6de)), closes [#112](https://github.com/alrayyes/forge-dashboard/issues/112)

## [0.30.0](https://github.com/alrayyes/forge-dashboard/compare/v0.29.1...v0.30.0) (2026-09-14)


### Features

* persist theme and per-column filters via a cookie ([#114](https://github.com/alrayyes/forge-dashboard/issues/114)) ([1b6b51a](https://github.com/alrayyes/forge-dashboard/commit/1b6b51acd3bf5e5b6817107f3451532e2f680717)), closes [#111](https://github.com/alrayyes/forge-dashboard/issues/111)

## [0.29.1](https://github.com/alrayyes/forge-dashboard/compare/v0.29.0...v0.29.1) (2026-09-13)


### Bug Fixes

* add a label filter select, so an active filter is always clearable ([#108](https://github.com/alrayyes/forge-dashboard/issues/108)) ([6a5dfbb](https://github.com/alrayyes/forge-dashboard/commit/6a5dfbb1ad4d42a301e7ef9e7513f0171bfa77c8)), closes [#107](https://github.com/alrayyes/forge-dashboard/issues/107)

## [0.29.0](https://github.com/alrayyes/forge-dashboard/compare/v0.28.0...v0.29.0) (2026-09-13)


### Features

* add group-by-forge, alongside group-by-repo ([#105](https://github.com/alrayyes/forge-dashboard/issues/105)) ([a01dd3d](https://github.com/alrayyes/forge-dashboard/commit/a01dd3da105b9d52f6344275057c81600de2dfb1)), closes [#102](https://github.com/alrayyes/forge-dashboard/issues/102)

## [0.28.0](https://github.com/alrayyes/forge-dashboard/compare/v0.27.2...v0.28.0) (2026-09-13)


### Features

* repo/author filters become selects, title gets autocomplete ([#103](https://github.com/alrayyes/forge-dashboard/issues/103)) ([52b2a5b](https://github.com/alrayyes/forge-dashboard/commit/52b2a5b9dd8f9f39281a04939f084a1bcbbe06c9)), closes [#101](https://github.com/alrayyes/forge-dashboard/issues/101)

## [0.27.2](https://github.com/alrayyes/forge-dashboard/compare/v0.27.1...v0.27.2) (2026-09-13)


### Bug Fixes

* pin bun below 1.4 so Dependabot's bun updater stops corrupting the lockfile ([#98](https://github.com/alrayyes/forge-dashboard/issues/98)) ([14958c4](https://github.com/alrayyes/forge-dashboard/commit/14958c432e28ce4377c8ebd3dd54191d944b5101)), closes [#95](https://github.com/alrayyes/forge-dashboard/issues/95)

## [0.27.1](https://github.com/alrayyes/forge-dashboard/compare/v0.27.0...v0.27.1) (2026-09-13)


### Bug Fixes

* lazily rewarm a user's dashboard after a process restart ([#93](https://github.com/alrayyes/forge-dashboard/issues/93)) ([f2b21e2](https://github.com/alrayyes/forge-dashboard/commit/f2b21e2d7b5aa6a7c92fddcb763b8b88d7a5b865))

## [0.27.0](https://github.com/alrayyes/forge-dashboard/compare/v0.26.0...v0.27.0) (2026-09-13)


### Features

* add an in-app release history page ([#90](https://github.com/alrayyes/forge-dashboard/issues/90)) ([6b2ec06](https://github.com/alrayyes/forge-dashboard/commit/6b2ec06501cac6d27dde2ef6abf3ee088e3f6898)), closes [#62](https://github.com/alrayyes/forge-dashboard/issues/62)

## [0.26.0](https://github.com/alrayyes/forge-dashboard/compare/v0.25.0...v0.26.0) (2026-09-13)


### Features

* push dashboard updates over Server-Sent Events ([#88](https://github.com/alrayyes/forge-dashboard/issues/88)) ([cf3017c](https://github.com/alrayyes/forge-dashboard/commit/cf3017c4c97c6cf3f1fc2581d2d5b6d6c224fdab))

## [0.25.0](https://github.com/alrayyes/forge-dashboard/compare/v0.24.0...v0.25.0) (2026-09-13)


### Features

* receive and verify GitHub/Forgejo repository webhooks ([#86](https://github.com/alrayyes/forge-dashboard/issues/86)) ([9aed17f](https://github.com/alrayyes/forge-dashboard/commit/9aed17f7df91b250e3af879e31f265c8b98f84b7))

## [0.24.0](https://github.com/alrayyes/forge-dashboard/compare/v0.23.1...v0.24.0) (2026-09-13)


### Features

* **settings:** per-user webhook credentials ([#81](https://github.com/alrayyes/forge-dashboard/issues/81)) ([22e8c4f](https://github.com/alrayyes/forge-dashboard/commit/22e8c4f7799216c47321faafa60e114cb89cc2c1))

## [0.23.1](https://github.com/alrayyes/forge-dashboard/compare/v0.23.0...v0.23.1) (2026-09-13)


### Bug Fixes

* set a busy_timeout on the SQLite connection ([#83](https://github.com/alrayyes/forge-dashboard/issues/83)) ([b8d2d09](https://github.com/alrayyes/forge-dashboard/commit/b8d2d09e2a5c3ae1226c8a7165b1739003d7f0c1)), closes [#82](https://github.com/alrayyes/forge-dashboard/issues/82)

## [0.23.0](https://github.com/alrayyes/forge-dashboard/compare/v0.22.0...v0.23.0) (2026-09-13)


### Features

* on-demand refresh and subscription on Aggregator/Manager ([#79](https://github.com/alrayyes/forge-dashboard/issues/79)) ([9d73d3d](https://github.com/alrayyes/forge-dashboard/commit/9d73d3d955777ef8ad95cd5d8df93b0d88b3c36e))

## [0.22.0](https://github.com/alrayyes/forge-dashboard/compare/v0.21.0...v0.22.0) (2026-09-13)


### Features

* render label colors on pull request and issue chips ([#77](https://github.com/alrayyes/forge-dashboard/issues/77)) ([a2412ca](https://github.com/alrayyes/forge-dashboard/commit/a2412caed5223c1b1b5e07f719b47cd0d56eebca)), closes [#42](https://github.com/alrayyes/forge-dashboard/issues/42)

## [0.21.0](https://github.com/alrayyes/forge-dashboard/compare/v0.20.0...v0.21.0) (2026-09-13)


### Features

* group pull requests and issues by repo ([#75](https://github.com/alrayyes/forge-dashboard/issues/75)) ([11227ba](https://github.com/alrayyes/forge-dashboard/commit/11227bac3fe85030b4598c6f6d0306441467a206)), closes [#39](https://github.com/alrayyes/forge-dashboard/issues/39)

## [0.20.0](https://github.com/alrayyes/forge-dashboard/compare/v0.19.0...v0.20.0) (2026-09-13)


### Features

* paginate pull request and issue lists ([#72](https://github.com/alrayyes/forge-dashboard/issues/72)) ([7db300a](https://github.com/alrayyes/forge-dashboard/commit/7db300a3ea73d38e4e6bc27ddf36ffe99a424c3e))

## [0.19.0](https://github.com/alrayyes/forge-dashboard/compare/v0.18.0...v0.19.0) (2026-09-13)


### Features

* make the repo filter a combobox of repos actually on screen ([#61](https://github.com/alrayyes/forge-dashboard/issues/61)) ([80e6502](https://github.com/alrayyes/forge-dashboard/commit/80e65029088b7c73bc70e58ff93a8cb46c24657c)), closes [#35](https://github.com/alrayyes/forge-dashboard/issues/35)

## [0.18.0](https://github.com/alrayyes/forge-dashboard/compare/v0.17.0...v0.18.0) (2026-09-13)


### Features

* show/hide toggle for the token fields on Settings ([#58](https://github.com/alrayyes/forge-dashboard/issues/58)) ([388f05e](https://github.com/alrayyes/forge-dashboard/commit/388f05e50042016d88634cc14743537ee8cd520f)), closes [#44](https://github.com/alrayyes/forge-dashboard/issues/44)


### Bug Fixes

* dark mode not respected outside the dashboard ([#57](https://github.com/alrayyes/forge-dashboard/issues/57)) ([907a2d9](https://github.com/alrayyes/forge-dashboard/commit/907a2d94d267bd81904f28bc5e27973bc9c00d63))

## [0.17.0](https://github.com/alrayyes/forge-dashboard/compare/v0.16.0...v0.17.0) (2026-09-13)


### Features

* click a label chip to filter the list by that label ([#55](https://github.com/alrayyes/forge-dashboard/issues/55)) ([20ed445](https://github.com/alrayyes/forge-dashboard/commit/20ed445cdb1637a0ad99c0d48d4945b2ef6afe34)), closes [#45](https://github.com/alrayyes/forge-dashboard/issues/45)

## [0.16.0](https://github.com/alrayyes/forge-dashboard/compare/v0.15.0...v0.16.0) (2026-09-13)


### Features

* click a CI status to filter the pull request list by it ([#52](https://github.com/alrayyes/forge-dashboard/issues/52)) ([716e420](https://github.com/alrayyes/forge-dashboard/commit/716e42039e1316d0076867ecca26cbbf11354c84))

## [0.15.0](https://github.com/alrayyes/forge-dashboard/compare/v0.14.1...v0.15.0) (2026-09-13)


### Features

* show the running version in the footer, linked to its release ([#50](https://github.com/alrayyes/forge-dashboard/issues/50)) ([69d6e12](https://github.com/alrayyes/forge-dashboard/commit/69d6e12301160d0a0c0f23704111bbbe1cce4126))

## [0.14.1](https://github.com/alrayyes/forge-dashboard/compare/v0.14.0...v0.14.1) (2026-09-13)


### Bug Fixes

* admin user table needing horizontal scroll at phone width ([#47](https://github.com/alrayyes/forge-dashboard/issues/47)) ([f016d98](https://github.com/alrayyes/forge-dashboard/commit/f016d986506fa899cd36a33a241628ceb35b4734))
* long titles with several label chips collapsing to single-word lines ([#46](https://github.com/alrayyes/forge-dashboard/issues/46)) ([800fc3e](https://github.com/alrayyes/forge-dashboard/commit/800fc3e6efb6db8d92a99e05a9352a1c160aad3e))

## [0.14.0](https://github.com/alrayyes/forge-dashboard/compare/v0.13.0...v0.14.0) (2026-09-13)


### Features

* require a Forgejo URL alongside any Forgejo token or username ([#33](https://github.com/alrayyes/forge-dashboard/issues/33)) ([75ade23](https://github.com/alrayyes/forge-dashboard/commit/75ade234b681ad5c35b55d242f46ed8a513fc75d))

## [0.13.0](https://github.com/alrayyes/forge-dashboard/compare/v0.12.1...v0.13.0) (2026-09-13)


### Features

* token creation guidance and required permissions on Settings ([#32](https://github.com/alrayyes/forge-dashboard/issues/32)) ([903146f](https://github.com/alrayyes/forge-dashboard/commit/903146f09cf1e7bcfa1736992629c9b4e2d2bcda)), closes [#29](https://github.com/alrayyes/forge-dashboard/issues/29)

## [0.12.1](https://github.com/alrayyes/forge-dashboard/compare/v0.12.0...v0.12.1) (2026-09-13)


### Bug Fixes

* add missing footer to settings, admin, and login pages ([#30](https://github.com/alrayyes/forge-dashboard/issues/30)) ([491e63e](https://github.com/alrayyes/forge-dashboard/commit/491e63ee12dbd27ed999e6399303af1e2cba1ed4)), closes [#28](https://github.com/alrayyes/forge-dashboard/issues/28)

## [0.12.0](https://github.com/alrayyes/forge-dashboard/compare/v0.11.0...v0.12.0) (2026-09-13)


### Features

* exclude archived and forked repos from the dashboard ([#26](https://github.com/alrayyes/forge-dashboard/issues/26)) ([e1b8c58](https://github.com/alrayyes/forge-dashboard/commit/e1b8c58df8ab97480740696d0a2bdac5ead54689))

## [0.11.0](https://github.com/alrayyes/forge-dashboard/compare/v0.10.0...v0.11.0) (2026-09-13)


### Features

* whoever registers first becomes admin ([#24](https://github.com/alrayyes/forge-dashboard/issues/24)) ([6452e3a](https://github.com/alrayyes/forge-dashboard/commit/6452e3a3b0c2e940e9c92965b406ba8c42e0d515))

## [0.10.0](https://github.com/alrayyes/forge-dashboard/compare/v0.9.0...v0.10.0) (2026-09-13)


### Features

* dashboard sharing ([#21](https://github.com/alrayyes/forge-dashboard/issues/21)) ([6b68928](https://github.com/alrayyes/forge-dashboard/commit/6b68928ec425dd975539015c0ec210f01b59b280))


### Bug Fixes

* dark-mode logo rendering as a blank tile ([#23](https://github.com/alrayyes/forge-dashboard/issues/23)) ([7933cb9](https://github.com/alrayyes/forge-dashboard/commit/7933cb90a03cfd6f07283fdcc6d56cf5e38256d3))

## [0.9.0](https://github.com/alrayyes/forge-dashboard/compare/v0.8.1...v0.9.0) (2026-09-13)


### Features

* admin user management ([#19](https://github.com/alrayyes/forge-dashboard/issues/19)) ([68448e8](https://github.com/alrayyes/forge-dashboard/commit/68448e8e1b56dc3dcb3e34528d853cd235ada1f9))

## [0.8.1](https://github.com/alrayyes/forge-dashboard/compare/v0.8.0...v0.8.1) (2026-09-12)


### Bug Fixes

* stop gitleaks flagging the e2e job's throwaway ENCRYPTION_KEY ([#17](https://github.com/alrayyes/forge-dashboard/issues/17)) ([780802f](https://github.com/alrayyes/forge-dashboard/commit/780802f3bd5ae01199ca9be4135c1598fac76dc2))

## [0.8.0](https://github.com/alrayyes/forge-dashboard/compare/v0.7.1...v0.8.0) (2026-09-12)


### Features

* per-user GitHub/Forgejo tokens ([#12](https://github.com/alrayyes/forge-dashboard/issues/12)) ([af6bdef](https://github.com/alrayyes/forge-dashboard/commit/af6bdef0ef4930d117543f9d24870cf587de72f6))

## [0.7.1](https://github.com/alrayyes/forge-dashboard/compare/v0.7.0...v0.7.1) (2026-09-12)


### Bug Fixes

* let a username reclaim an abandoned registration ([#11](https://github.com/alrayyes/forge-dashboard/issues/11)) ([880b702](https://github.com/alrayyes/forge-dashboard/commit/880b702280e19ee403122ff4ea1b84753fcece65))

## [0.7.0](https://github.com/alrayyes/forge-dashboard/compare/v0.6.0...v0.7.0) (2026-09-12)


### Features

* passkey login gates the dashboard ([#9](https://github.com/alrayyes/forge-dashboard/issues/9)) ([0127736](https://github.com/alrayyes/forge-dashboard/commit/012773608b192fbf38bed2cadc585388b2b78bb1))

## [0.6.0](https://github.com/alrayyes/forge-dashboard/compare/v0.5.0...v0.6.0) (2026-09-12)


### Features

* **forgejo:** support a token-free public-repos fallback ([#6](https://github.com/alrayyes/forge-dashboard/issues/6)) ([54fd0d6](https://github.com/alrayyes/forge-dashboard/commit/54fd0d6b47f7af38a4b795f6670cfc2db0a15a20))


### Bug Fixes

* **deps:** bump github.com/moby/go-archive from 0.2.0 to 0.3.0 ([#5](https://github.com/alrayyes/forge-dashboard/issues/5)) ([aa91711](https://github.com/alrayyes/forge-dashboard/commit/aa917112c50eb4a1ff83ba02ac7edb8265272774))

## [0.5.0](https://github.com/alrayyes/forge-dashboard/compare/v0.4.2...v0.5.0) (2026-09-12)


### Features

* v1 forge dashboard ([#2](https://github.com/alrayyes/forge-dashboard/issues/2)) ([a6fa3c8](https://github.com/alrayyes/forge-dashboard/commit/a6fa3c8fc2a6da0ee025b251836c6e8c838cfe29))
