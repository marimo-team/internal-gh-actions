#!/usr/bin/env bash
set -euo pipefail
WAIT_EVENT="${WAIT_EVENT:-push}"
[[ "$WAIT_EVENT" == push || "$WAIT_EVENT" == pull_request ]] || exit 1

if [[ ! "$WAIT_COMMIT" =~ ^[0-9a-f]{40}$ || -z "$WAIT_BRANCH" ]]; then
  echo "::error::Provide a full commit SHA and a branch"
  exit 1
fi

count=0
while IFS= read -r workflow; do
  [[ -z "$workflow" ]] && continue
  if [[ ! "$workflow" =~ ^[a-zA-Z0-9_][a-zA-Z0-9_.-]*\.ya?ml$ ]]; then
    echo "::error::Expected workflow filenames, one per line"
    exit 1
  fi
  count=$((count + 1))
  run_id=""
  for _attempt in {1..30}; do
    run_id="$(gh run list --workflow "$workflow" --branch "$WAIT_BRANCH" --commit "$WAIT_COMMIT" --event "$WAIT_EVENT" --limit 1 --json databaseId --jq '.[0].databaseId // empty')"
    if [[ -n "$run_id" ]]; then break; fi
    sleep 10
  done
  if [[ -z "$run_id" ]]; then
    echo "::error::No $workflow $WAIT_EVENT run found for $WAIT_COMMIT"
    exit 1
  fi
  gh run watch "$run_id" --exit-status --interval 20
done <<< "$WAIT_WORKFLOWS"

if [[ "$count" == 0 ]]; then
  echo "::error::Provide at least one workflow filename"
  exit 1
fi
