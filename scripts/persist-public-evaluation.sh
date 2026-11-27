#!/usr/bin/env bash
# This is the only step with write access. Append via fast-forward pushes and
# retry against the winner; a global workflow concurrency key could cancel a
# pending evaluation before it persisted its result.
set -euo pipefail
bundle=$1
id=$2
branch=public-report-data
ref="refs/heads/$branch"
remote="$GITHUB_SERVER_URL/$GITHUB_REPOSITORY.git"
data=$(mktemp -d)
trap 'rm -rf "$data"' EXIT

git -C "$data" init -q -b "$branch"
git -C "$data" config user.name 'github-actions[bot]'
git -C "$data" config user.email '41898282+github-actions[bot]@users.noreply.github.com'

# Pass the token only to Git, via per-command config (no stored credentials).
# Do not inherit it when invoking the report verifier/generator.
header="AUTHORIZATION: basic $(printf 'x-access-token:%s' "$PUSH_TOKEN" | base64 | tr -d '\r\n')"
echo "::add-mask::${header#AUTHORIZATION: basic }"
unset PUSH_TOKEN
remote_git() {
  GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraHeader GIT_CONFIG_VALUE_0="$header" git -C "$data" "$@"
}

for attempt in 1 2 3 4; do
  tip=$(git ls-remote --heads "$remote" "$ref")
  if [[ -n "$tip" ]]; then
    remote_git fetch --quiet --no-tags --depth=1 "$remote" "$ref"
    git -C "$data" reset --hard --quiet FETCH_HEAD
  fi
  bun scripts/public-evaluation.ts save "$data" "$bundle" "$id"
  git -C "$data" add -- reports/
  if ! git -C "$data" diff --cached --quiet; then
    git -C "$data" commit --quiet -m "Store public evaluation $id"
  elif [[ -n "$tip" ]]; then
    echo "Report $id is already stored."
    exit 0
  fi
  # If the branch is still missing after a rejected initial push, retry the
  # unchanged local commit instead of mistaking it for persisted evidence.
  if remote_git push "$remote" "HEAD:$ref"; then
    echo "Stored $id on $branch; deploy the reports via publish-public-reports."
    exit 0
  fi
  if [[ "$attempt" -lt 4 ]]; then sleep "$((attempt * 2))"; fi
done
echo "Could not persist $id after four attempts; the compact report remains available as a run artifact." >&2
exit 1
