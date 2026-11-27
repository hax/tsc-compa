#!/usr/bin/env bash
# This is the only step with write access. Commit the whole report update via
# a fast-forward push and recheck the winning evidence after a rejected push.
set -euo pipefail
bundle=$1
id=$2
shift 2
branch=public-report-data
ref="refs/heads/$branch"
remote="$GITHUB_SERVER_URL/$GITHUB_REPOSITORY.git"
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

# Pass the token only to Git, via per-command config (no stored credentials).
# Do not inherit it when invoking the report verifier/generator.
header="AUTHORIZATION: basic $(printf 'x-access-token:%s' "$PUSH_TOKEN" | base64 | tr -d '\r\n')"
echo "::add-mask::${header#AUTHORIZATION: basic }"
unset PUSH_TOKEN
remote_git() {
  GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraHeader GIT_CONFIG_VALUE_0="$header" git -C "$data" "$@"
}
summary() {
  printf '%s\n' "$1"
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then printf '%s\n' "$1" >> "$GITHUB_STEP_SUMMARY"; fi
}

for attempt in 1 2 3 4; do
  data="$scratch/$attempt"
  git init -q -b "$branch" "$data"
  git -C "$data" config user.name 'github-actions[bot]'
  git -C "$data" config user.email '41898282+github-actions[bot]@users.noreply.github.com'
  tip=$(remote_git ls-remote --heads "$remote" "$ref")
  if [[ -n "$tip" ]]; then
    remote_git fetch --quiet --no-tags --depth=1 "$remote" "$ref"
    git -C "$data" reset --hard --quiet FETCH_HEAD
  fi
  result=$(bun scripts/public-evaluation.ts save "$data" "$bundle" "$id" "$@")
  case "$result" in
    already-stored) summary "Report $id is already stored; no public data changed."; exit 0 ;;
    superseded) summary "Forced run for $id completed, but newer evidence is already stored; no public data changed."; exit 0 ;;
    stored) action=Stored ;;
    refreshed) action=Refreshed ;;
    *) echo "Unexpected save result: $result" >&2; exit 1 ;;
  esac
  git -C "$data" add -- reports/
  git -C "$data" commit --quiet -m "$action public evaluation $id"
  if remote_git push "$remote" "HEAD:$ref"; then
    summary "$action $id on $branch. Pages was not deployed; use publish-public-reports to publish the update."
    exit 0
  fi
  if [[ "$attempt" -lt 4 ]]; then sleep "$((attempt * 2))"; fi
done
echo "Could not persist $id after four attempts; the compact report remains available as a run artifact." >&2
exit 1
