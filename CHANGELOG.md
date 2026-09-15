# Changelog

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
