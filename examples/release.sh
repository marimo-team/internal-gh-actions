#!/usr/bin/env bash
set -euo pipefail
# Install the reviewed shared CLI first; see README.md.
if [[ $# != 1 ]]; then
  echo 'Usage: release.sh <patch|minor|major|X.Y.Z>' >&2
  exit 2
fi
GITHUB_REPOSITORY=team/repo exec gh release-control request "$1"
