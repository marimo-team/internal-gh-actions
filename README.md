# Shared release actions

Release flow: prepare `release/X.Y.Z` → approve and merge its PR → tag the merge commit as `vX.Y.Z`
→ publish. Pin every caller to a reviewed commit SHA.

These composite actions require Bash, Git, and Node 22+. They have no npm dependencies. Repository
adapters own file updates and builds. Shared actions validate versions and prepared changes; they
never merge PRs or overwrite release branches or tags.

| Action                 | Required inputs                                                | Optional inputs            | Outputs                                           |
| ---------------------- | -------------------------------------------------------------- | -------------------------- | ------------------------------------------------- |
| `prepare-release`      | `version`                                                      | —                          | `version`, `current-version`, `manifest`, `files` |
| `release-contract`     | —                                                              | `workflows`                | —                                                 |
| `release-pr`           | `app-id`, `private-key`, `current-version`, `version`, `files` | `base`, `manifest`         | `url`, `number`                                   |
| `release-tag`          | `app-id`, `private-key`                                        | `base`, `manifest`         | `tag`, `created`                                  |
| `validate-release`     | —                                                              | `base`, `manifest`         | `version`, `tag`                                  |
| `wait-for-workflows`   | `workflows`, `commit`                                          | `branch`, `event`, `token` | —                                                 |
| `release-notification` | `slack-webhook-url`, either `results` or `status`              | `artifact-url`             | —                                                 |

`base` defaults to `main`. `manifest` defaults to `package.json` and must be JSON with a top-level
stable `version`, without `v`, leading zeros, or surrounding whitespace.

## Repository setup

- Install a dedicated release App on its active consumers. Grant Contents write; PR creation also
  needs Pull requests write. No Administration permission is needed.
- Store `RELEASE_APP_ID` as a variable and `RELEASE_APP_PRIVATE_KEY` in a protected `release`
  environment. Restrict that environment to `main` and `refs/pull/*/merge`. Require a release-team reviewer, prevent
  self-review, and disable admin bypass. Remove repository/org copies of the key. Token scoping
  alone does not restrict the private key's authority.
- Require independent PR review and passing CI on the base branch, without bypass.
- Add a creation-only ruleset for `refs/tags/v*`, allowing the release App to bypass creation
  restriction. Keep a separate immutable-tag ruleset with no bypass actors.

The PR/tag jobs declare `environment: release`. Repository writers may dispatch, but a reviewer must
approve credential access. App tokens are scoped to the current repository and operation, revoked at
job end, and never persisted in Git config.

## Prepare a PR

Use the [preparation example](examples/release-pr.yml). Dispatch from the base branch, check it out
without persisted credentials, and run the repository's bump adapter. The adapter changes files but
does not commit or tag. Supply its resulting `version` and a newline-separated `files` allowlist of
exact paths.

The action rejects unexpected files, workflows, deletions, symlinks, mode changes, and invalid UTF-8
before minting a token. It creates one commit based on the checkout. If the base advanced, rerun
preparation. An existing branch must have the same tree and parent; an open PR is reused. A closed
PR must be reopened explicitly. Serialize preparation with a repository-wide concurrency group.

`prepare-release` reads `.release.json`, enforces stable increasing versions, and passes a resolved
version to the adapter. `release-pr` rechecks the increase before requesting credentials. Metadata
commands must validate version mirrors and print JSON with a `version` field; adapters must not
commit or tag.

```json
{
  "repository": "team/repo",
  "manifest": "package.json",
  "prepare": ["npm", "version", "--no-git-tag-version", "--ignore-scripts", "--package-lock=false"],
  "files": ["package.json"],
  "command": ["pnpm", "release"],
  "docs": "RELEASING.md",
  "checks": [["pnpm", "install", "--lockfile-only", "--frozen-lockfile", "--ignore-scripts"]]
}
```

Use `metadata: ["python3", "scripts/release-metadata.py"]` instead of `manifest` when versions span
files or use another format.

Run `release-contract` in a required job named `Release checks`, on PRs and pushes to `main`, with
`contents: read` and `actions: read`. It installs Node, uv, and pnpm when needed. Disposable
checkouts exercise the documented command, all bump types, explicit versions, mirrors, lock checks,
and the file allowlist. Equal, lower, and prerelease versions must fail before mutation. Source
checkouts stay untouched, and no credentials are needed. Pass package CI filenames as `workflows`;
each must run on every PR and main push, without path filters.

## Tag and publish

Use the [tagging example](examples/release-tag.yml) on merged PR closures. Check out
`merge_commit_sha` and validate additional package versions before calling the action. It
independently checks the same repository, base, exact branch/title/version, and checkout. It creates
an annotated tag through the API. An identical existing tag is a no-op; a conflicting tag fails.
Neither path moves or deletes tags.

Use the [publication example](examples/release-workflow.yml) with full checkout history.
`validate-release` requires tag/manifest equality, the exact tag checkout, and base-branch ancestry.
Every required publisher must depend on it. Repository tag rules enforce who may create tags;
ancestry alone is not proof of release-PR provenance.

Rerun failed publisher jobs after a partial release. An existing tag does not trigger publication
again. Registry credentials stay with repository-owned publisher jobs.

## Wait for workflows

`wait-for-workflows` requires `gh` and `actions: read`. It requires successful runs for the exact
`commit`, `branch` (default: `main`), and `event` (default: `push`; also accepts `pull_request`).
Pass workflow filenames on separate lines. Discovery times out after five minutes per workflow. Set
a job timeout to bound the full wait.

## Notifications and tests

In an `if: always()` job depending on every required publisher, pass
`results: ${{ toJSON(needs) }}`. Any failed, cancelled, or skipped required job reports failure.
Optional jobs need a separate policy. Existing `status: ${{ job.status }}` callers remain supported;
`results` takes precedence. Fork PRs are skipped. Payloads use JSON serialization and plain text for
dynamic values.

Run `node --test test/*.test.mjs` and `actionlint`. Tests use local Git fixtures and mock APIs; they
do not create remote releases or send notifications.

## Release command

Install Node 22+ and authenticate `gh`. Clone this repository to a stable local path:

```sh
gh repo clone marimo-team/internal-gh-actions "$HOME/.local/share/internal-gh-actions"
# Check out the reviewed commit used by your release workflows.
gh alias set release-control '!node "$HOME/.local/share/internal-gh-actions/bin/release.mjs" "$@"'
gh release-control request patch
gh release-control status
gh release-control approve
```

The request command prints the exact dispatch URL. It does not search for another user's latest run.
Status reports approval, PR, tagging, and publishing progress. Failures retain their run link.
Approval checks workflow identity and merged PR provenance before it submits a pending deployment.
GitHub enforces reviewer membership and prevents self-review. Multiple waiting runs require an explicit run ID.
Set `GITHUB_REPOSITORY=owner/repo` to select another repository.

## Approval notifications

Add the independent `notify-approval` job from both workflow examples. Keep its job name
`Notify release approval`. It uses `actions: read`, `pull-requests: read`, and `contents: read`.
It does not check out repository code or request the protected environment.
Supply the repository or organization secret `SLACK_WEBHOOK_URL_RELEASES`.

The observer polls pending deployments for up to ten minutes. It sends one message only after
GitHub exposes the `release` approval request. Rejected or completed jobs produce no message.
Reruns do not repeat the original notification. If notification delivery fails, use the run URL
from the request command or status command. Slack delivery is not retried automatically.

Approval observers must use a runner allowed by the organization IP policy. The examples use
`vars.CI_RUNNER_SMALL`, matching the managed release repositories. A public `ubuntu-latest` runner
can receive HTTP 403 even with the correct token permissions.
