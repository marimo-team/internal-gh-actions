# Shared release actions

Release flow: prepare `release/X.Y.Z` → approve and merge its PR → tag the merge
commit as `vX.Y.Z` → publish. Pin every caller to a reviewed commit SHA.

These composite actions require Bash, Git, and Node 22+. They have no npm
dependencies. Repository adapters own version bumps and builds; shared actions
never run arbitrary preparation commands, merge PRs, or overwrite release
branches or tags.

| Action                 | Required inputs                                   | Optional inputs    | Outputs          |
| ---------------------- | ------------------------------------------------- | ------------------ | ---------------- |
| `release-pr`           | `app-id`, `private-key`, `version`, `files`       | `base`, `manifest` | `url`, `number`  |
| `release-tag`          | `app-id`, `private-key`                           | `base`, `manifest` | `tag`, `created` |
| `validate-release`     | —                                                 | `base`, `manifest` | `version`, `tag` |
| `release-notification` | `slack-webhook-url`, either `results` or `status` | `artifact-url`     | —                |

`base` defaults to `main`. `manifest` defaults to `package.json` and must be
JSON with a top-level stable `version`, without `v`, leading zeros, or
surrounding whitespace.

## Repository setup

- Install a dedicated release App on its active consumers. Grant Contents write;
  PR creation also needs Pull requests write. No Administration permission is
  needed.
- Store `RELEASE_APP_ID` as a variable and `RELEASE_APP_PRIVATE_KEY` in a
  protected `release` environment. Restrict that environment to `main`, require
  a release-team reviewer, prevent self-review, and disable admin bypass. Remove
  repository/org copies of the key. Token scoping alone does not restrict the
  private key's authority.
- Require independent PR review and passing CI on the base branch, without
  bypass.
- Add a creation-only ruleset for `refs/tags/v*`, allowing the release App to
  bypass creation restriction. Keep a separate immutable-tag ruleset with no
  bypass actors.

The PR/tag jobs declare `environment: release`. Repository writers may dispatch,
but a reviewer must approve credential access. App tokens are scoped to the
current repository and operation, revoked at job end, and never persisted in Git
config.

## Prepare a PR

Use the [preparation example](examples/release-pr.yml). Dispatch from the base
branch, check it out without persisted credentials, and run the repository's
bump adapter. The adapter changes files but does not commit or tag. Supply its
resulting `version` and a newline-separated `files` allowlist of exact paths.

The action rejects unexpected files, workflows, deletions, symlinks, executable
files, and invalid UTF-8 before minting a token. It creates one commit based on
the checkout. If the base advanced, rerun preparation. An existing branch must
have the same tree and parent; an open PR is reused. A closed PR must be
reopened explicitly. Serialize preparation with a repository-wide concurrency
group.

Adapters enforce increasing versions and cross-manifest consistency. For Python,
commit a JSON release manifest beside pyproject.toml and pass it to all three
actions.

## Tag and publish

Use the [tagging example](examples/release-tag.yml) on merged PR closures. Check
out `merge_commit_sha` and validate additional package versions before calling
the action. It independently checks the same repository, base, exact
branch/title/version, and checkout. It creates an annotated tag through the API.
An identical existing tag is a no-op; a conflicting tag fails. Neither path
moves or deletes tags.

Use the [publication example](examples/release-workflow.yml) with full checkout
history. `validate-release` requires tag/manifest equality, the exact tag
checkout, and base-branch ancestry. Every required publisher must depend on it.
Repository tag rules enforce who may create tags; ancestry alone is not proof of
release-PR provenance.

Rerun failed publisher jobs after a partial release. An existing tag does not
trigger publication again. Registry credentials stay with repository-owned
publisher jobs.

## Notifications and tests

In an `if: always()` job depending on every required publisher, pass
`results: ${{ toJSON(needs) }}`. Any failed, cancelled, or skipped required job
reports failure. Optional jobs need a separate policy. Existing
`status: ${{ job.status }}` callers remain supported; `results` takes
precedence. Fork PRs are skipped. Payloads use JSON serialization and plain text
for dynamic values.

Run `node --test test/*.test.mjs` and `actionlint`. Tests use local Git fixtures
and mock APIs; they do not create remote releases or send notifications.
