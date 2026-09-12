// semantic-release replaces release-please, which is GitHub-only
// (rules/releases.md, go.md). goreleaser's job is unchanged: it still
// only attaches binaries to a release that already exists. Only the
// tool that decides the version and cuts the tag is different.
//
// tagFormat: this repo's release-please config used `include-v-in-tag:
// true`, so semantic-release's default (`v${version}`) already matches.
// No git tags exist yet, so this is also this repo's first release either
// way — check `git tag` before copying this file into a repo that already
// has bare (non-v-prefixed) tags; getting the format wrong there publishes
// 1.0.0 over history that's already released.
const forgejoUrl =
  process.env.FORGEJO_SERVER_URL ?? "https://git.higherlearning.eu";

export default {
  branches: ["main"],
  plugins: [
    ["@semantic-release/commit-analyzer", { preset: "conventionalcommits" }],
    [
      "@semantic-release/release-notes-generator",
      { preset: "conventionalcommits" },
    ],
    ["@semantic-release/changelog", { changelogTitle: "# Changelog" }],
    // Creates the Forgejo release. forgejoToken is passed explicitly rather
    // than left to the environment: the runner injects its own FORGEJO_TOKEN
    // into every job automatically, with repository write, and the plugin
    // reads env.FORGEJO_TOKEN when given no token of its own — so leaving it
    // to the environment means the release is authenticated by whichever of
    // the two the runner happens to leave in place. Passing forgejoToken
    // settles it: it wins over the environment in the plugin's own
    // resolution, and RELEASE_TOKEN is a name Forgejo neither reserves nor
    // sets (see FORGEJO.md's CI gotcha on reserved secret prefixes).
    [
      "@ribbon-studios/semantic-release-forgejo",
      { forgejoUrl, forgejoToken: process.env.RELEASE_TOKEN },
    ],
    // Last of the prepare/publish plugins on purpose: it commits what the
    // changelog plugin wrote, and semantic-release tags the commit it made.
    // No package.json bump here, unlike a JS project's config — a Go binary
    // has no manifest to bump (go.md); goreleaser reads the version off the
    // tag instead, via -X main.version={{.Tag}} in .goreleaser.yml.
    [
      "@semantic-release/git",
      {
        assets: ["CHANGELOG.md"],
        message: "chore(release): ${nextRelease.version} [skip ci]",
      },
    ],
  ],
};
