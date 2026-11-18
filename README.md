# Shared marimo GitHub Actions

Release flow: prepare `release/X.Y.Z` → review and merge its PR → create
`vX.Y.Z` at the merge commit → publish assets from that tag.

Pin each action to a reviewed commit SHA. These composite actions require Bash,
Git, and Node 22 or later on the runner. They have no npm dependencies. They do
not install runtimes, run package scripts, merge PRs, or bypass branch
protection.

| Action                 | Purpose                                                            | Outputs          |
| ---------------------- | ------------------------------------------------------------------ | ---------------- |
| `release-pr`           | Create a versioned branch and PR from prepared file changes        | `url`, `number`  |
| `release-tag`          | Validate a merged release PR and create an annotated immutable tag | `tag`, `created` |
| `validate-release`     | Check tag/version equality and base-branch ancestry                | `version`, `tag` |
| `release-notification` | Report one job or aggregate publisher results to Slack             | —                |

## Release App

Install a dedicated release App on the repositories that use these actions.
Store its ID in `vars.RELEASE_APP_ID` and key in
`secrets.RELEASE_APP_PRIVATE_KEY`. Grant Contents write for tagging and Pull
requests write for PR creation. No Administration permission or protection
bypass is required. Each action requests only the current repository and its
required permissions. Tokens are revoked by the token action's post step and
never persisted in a checkout.

App-created PRs and tags trigger downstream workflows. See
[GitHub's workflow trigger documentation](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow).
Keep `GITHUB_TOKEN` permissions at Contents read for these jobs. Pass the App
key only to the release action, after repository-specific preparation and
validation. Run preparation only from trusted base-branch code, without
restoring untrusted caches.

## Open a release PR

Use a `workflow_dispatch` workflow running from the release base branch. Check
out that branch with `persist-credentials: false`, then run the repository's
version preparation script. Do not commit or tag in that script. Call
`release-pr` with:

- `app-id`, `private-key`: release App credentials.
- `version`: the prepared stable version, without `v`.
- `files`: newline-separated exact paths that preparation may change.
- `base`: default `main`.
- `manifest`: default `package.json`; JSON with a top-level `version` field.

The action validates the diff before minting the token. It accepts regular UTF-8
files, adds new files, and rejects deletions, symlinks, workflow files, and
changes outside the allowlist. Use this for manifests and lockfiles, not
executable or binary assets. It creates one commit from the checked-out base; it
never writes the base branch or force-updates a release branch. If the base
advanced, rerun preparation. If the same release branch already exists, its tree
and parent must match exactly. An open PR is reused; a closed PR requires a
maintainer to reopen it or choose a new version. Use a workflow concurrency
group to serialize preparation in each repository.

Version bump semantics and cross-manifest consistency remain the caller's
responsibility. For a Python repository, pass a generated JSON release manifest
and include it in the version PR along with pyproject.toml. Use the same
manifest for tagging and validation.

## Tag a merged release PR

Call `release-tag` from `pull_request: { types: [closed] }` after checking out
`github.event.pull_request.merge_commit_sha` with `persist-credentials: false`.
The wrapper should skip ordinary PRs and unmerged closures. Validate any
additional package versions in earlier steps. Supply `app-id`, `private-key`,
and optionally `base` and `manifest`.

The action independently requires a merged, same-repository PR targeting the
base, an exact `release/X.Y.Z` branch, an exact `release: X.Y.Z` title, and the
matching manifest version. It rejects leading zeros and prereleases. The
checkout must be the exact merge commit. It creates an annotated tag through the
GitHub API.

Rerunning succeeds without writing when the tag already resolves to the merge
commit, including annotated tags. A conflicting tag fails. No tags are
force-moved. An existing tag does not retrigger publication; rerun the failed
publisher workflow. Use a per-PR concurrency group with
`cancel-in-progress: false`.

## Validate before publishing

Check out the release tag with `fetch-depth: 0` and
`persist-credentials: false`, then call `validate-release` with the same `base`
and `manifest`. The action checks that the checkout is the tag's commit, the tag
matches the manifest's stable version, and the commit is on `origin/BASE`. Make
every publisher depend on this validation. Repository rulesets must separately
restrict who can create release tags; ancestry alone does not prove that a tag
was produced by the release App.

## Notify once

Use `release-notification` from an `if: always()` job that `needs` every
required publisher. Pass `results: ${{ toJSON(needs) }}` and the Slack webhook.
Any failure, cancellation, or skipped required job reports failure. List only
required jobs in `needs`; optional publication should have its own notification
policy.

Existing callers can continue using `status: ${{ job.status }}`. `results` takes
precedence over `status`. `artifact-url` remains optional. Fork PRs are skipped.
Payloads are serialized as JSON and use plain text for interpolated values.

See [the example workflows](examples/release-workflow.yml). Replace the example
SHA placeholder with a reviewed commit before use. Registry publishing remains
in repository-owned jobs; this repository does not need registry credentials.

## Development

Run `node --test test/*.test.mjs` and `actionlint`. Tests use local Git fixtures
and mock GitHub APIs; they never create remote branches, PRs, tags, or Slack
messages.
