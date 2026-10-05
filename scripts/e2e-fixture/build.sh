#!/usr/bin/env bash
# Builds one pull request per state in alrayyes/forge-dashboard-e2e-fixture, for
# the GitHub comparison test (#950). Safe to run on a freshly reset repo; run
# reset.sh first otherwise. Needs gh (logged in as the repo owner) and git.
#
#   scripts/e2e-fixture/build.sh [path-to-a-clone-of-the-fixture]
#
# Branch protection goes on last: the script pushes to the base branches
# directly to make PRs behind or conflicting, and protection would refuse that.
set -euo pipefail

REPO=alrayyes/forge-dashboard-e2e-fixture
DIR=${1:-$(dirname "$0")/../../../forge-dashboard-e2e-fixture}
cd "$DIR"
git fetch -q origin
git checkout -q -B main origin/main
GIT=(git -c user.name="Ryan Kes" -c user.email="ryan@andthensome.nl")

# Bases, one per branch-protection setup.
BASES=(base/clean base/open base/req-check base/req-check-admin base/strict base/review base/linear base/convo)
for b in "${BASES[@]}"; do git push -q -f origin "main:refs/heads/$b"; done

# pr NAME BASE REQUIRED OPTIONAL [draft] [FILE=CONTENT]
# REQUIRED and OPTIONAL are what ci/required.txt and ci/optional.txt say:
# pass, fail or slow (slow keeps the check pending for ten minutes).
pr() {
  local name=$1 base=$2 req=$3 opt=$4 draft=${5:-} edit=${6:-}
  git checkout -q -B "head/$name" "origin/$base"
  mkdir -p changes
  echo "$req" >ci/required.txt
  echo "$opt" >ci/optional.txt
  echo "$name" >"changes/$name.txt"
  [ -n "$edit" ] && echo "${edit#*=}" >"${edit%%=*}"
  git add -A
  "${GIT[@]}" commit -qm "test: $name"
  git push -q -f origin "head/$name"
  gh pr create -R "$REPO" --base "$base" --head "head/$name" --title "$name" \
    --body "Fixture scenario \`$name\`. Required check: $req. Optional check: $opt." ${draft:+--draft} >/dev/null
  echo "created $name -> $base"
}

# Clean and checks.
pr clean-no-protection        base/clean          pass pass
pr clean-required-pass        base/req-check      pass pass
pr required-failing           base/req-check      fail pass
pr required-pending           base/req-check      slow pass
pr optional-failing           base/req-check      pass fail
pr optional-pending           base/req-check      pass slow
pr required-failing-admin-on  base/req-check-admin fail pass

# Draft.
pr draft-clean                base/clean          pass pass draft
pr draft-required-failing     base/req-check      fail pass draft

# Review, conversation, history rules.
pr review-required            base/review         pass pass
pr conversation-unresolved    base/convo          pass pass
pr linear-history             base/linear         pass pass

# Behind: strict protection makes it BEHIND; without it GitHub still says clean.
pr behind-strict              base/strict         pass pass
pr behind-not-strict          base/open           pass pass

# Conflicting: head and base both change conflict.txt.
git checkout -q -B head/conflict-seed origin/base/open
echo "line" >conflict.txt; git add -A; "${GIT[@]}" commit -qm "test: seed conflict.txt"
git push -q -f origin head/conflict-seed:refs/heads/base/open
pr conflicting                base/open           pass pass "" "conflict.txt=head side"
# The head edits the line one way, the base edits it another way further down.

# Empty: head's change lands on base as a different commit, so the PR has no diff.
pr empty-after-base-took-it   base/open           pass pass

# Stacked: B's base is A's head branch.
git push -q -f origin head/clean-no-protection:refs/heads/base/stack-parent
pr stacked-child              base/stack-parent   pass pass

# Closed without merging.
pr closed-unmerged            base/clean          pass pass
gh pr close -R "$REPO" head/closed-unmerged >/dev/null

# Make the "behind" and "conflicting" PRs so, by advancing their bases.
git checkout -q -B advance origin/base/strict
echo "advance" >advance.txt; git add -A; "${GIT[@]}" commit -qm "test: advance base"
git push -q -f origin advance:refs/heads/base/strict
git checkout -q -B advance-open origin/base/open
echo "advance" >advance.txt
echo "base side" >conflict.txt
git add -A; "${GIT[@]}" commit -qm "test: advance base/open"
git push -q origin advance-open:refs/heads/base/open
# Empty PR: put the same content on base under a new commit.
git checkout -q -B take origin/base/open
mkdir -p changes ci; echo "empty-after-base-took-it" >changes/empty-after-base-took-it.txt
echo "pass" >ci/required.txt; echo "pass" >ci/optional.txt
git add -A; "${GIT[@]}" commit -qm "test: base takes the empty PR's change" || true
git push -q origin take:refs/heads/base/open

# Protection, last.
prot() { gh api -X PUT "repos/$REPO/branches/$1/protection" --input - >/dev/null; }
prot base/req-check <<'J'
{"required_status_checks":{"strict":false,"contexts":["required-check"]},"enforce_admins":false,"required_pull_request_reviews":null,"restrictions":null}
J
prot base/req-check-admin <<'J'
{"required_status_checks":{"strict":false,"contexts":["required-check"]},"enforce_admins":true,"required_pull_request_reviews":null,"restrictions":null}
J
prot base/strict <<'J'
{"required_status_checks":{"strict":true,"contexts":["required-check"]},"enforce_admins":false,"required_pull_request_reviews":null,"restrictions":null}
J
prot base/review <<'J'
{"required_status_checks":null,"enforce_admins":false,"required_pull_request_reviews":{"required_approving_review_count":1},"restrictions":null}
J
prot base/linear <<'J'
{"required_status_checks":null,"enforce_admins":false,"required_pull_request_reviews":null,"restrictions":null,"required_linear_history":true}
J
prot base/convo <<'J'
{"required_status_checks":null,"enforce_admins":false,"required_pull_request_reviews":null,"restrictions":null,"required_conversation_resolution":true}
J

# Unresolved conversation: a review comment on the PR's diff.
n=$(gh pr view -R "$REPO" head/conversation-unresolved --json number --jq .number)
gh api "repos/$REPO/pulls/$n/comments" -f body="Unresolved thread." -f commit_id="$(git rev-parse origin/head/conversation-unresolved)" -f path=changes/conversation-unresolved.txt -F line=1 -f side=RIGHT >/dev/null

# Auto-merge armed on a PR that can't merge yet.
n=$(gh pr view -R "$REPO" head/required-pending --json number --jq .number)
gh pr merge -R "$REPO" "$n" --auto --squash >/dev/null || echo "could not arm auto-merge on required-pending"

echo "done: $(gh pr list -R "$REPO" --state open --json number --jq length) open pull requests"
