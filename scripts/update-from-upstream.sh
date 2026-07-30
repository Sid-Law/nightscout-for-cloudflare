#!/usr/bin/env bash

set -Eeuo pipefail

mode="${1:-}"
upstream_repository="${NSCF_UPSTREAM_REPOSITORY:-sid-luo/nightscout-for-cloudflare}"
upstream_branch="${NSCF_UPSTREAM_BRANCH:-main}"
default_branch="${NSCF_DEFAULT_BRANCH:-main}"
upstream_url="${NSCF_UPSTREAM_URL:-https://github.com/${upstream_repository}.git}"
remote_name="nscf-upstream"

write_output() {
  local name="$1"
  local value="$2"

  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    printf '%s=%s\n' "$name" "$value" >> "$GITHUB_OUTPUT"
  else
    printf '%s=%s\n' "$name" "$value"
  fi
}

write_summary() {
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    printf '%s\n' "$1" >> "$GITHUB_STEP_SUMMARY"
  fi
}

fail() {
  write_summary "❌ $1"
  printf '::error::%s\n' "$1" >&2
  exit 1
}

configure_commit_identity() {
  git config user.name "Nightscout for Cloudflare Updater"
  git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
}

fetch_upstream() {
  git remote remove "$remote_name" >/dev/null 2>&1 || true
  git remote add "$remote_name" "$upstream_url"
  git fetch --no-tags "$remote_name" "$upstream_branch"
  git rev-parse FETCH_HEAD
}

merge_upstream() {
  local upstream_sha="$1"

  configure_commit_identity
  if ! git merge --no-ff "$upstream_sha" \
    -m "Update Nightscout for Cloudflare from official repository"; then
    git merge --abort >/dev/null 2>&1 || true
    fail "The update conflicts with changes in this deployed copy. The current main branch was not changed."
  fi
}

if [[ "$mode" != "validate" && "$mode" != "apply" ]]; then
  fail "Usage: update-from-upstream.sh validate|apply"
fi

current_branch="$(git symbolic-ref --quiet --short HEAD || true)"
if [[ "$current_branch" != "$default_branch" ]]; then
  fail "Expected branch '${default_branch}', but checked out '${current_branch:-detached HEAD}'."
fi

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  fail "The repository contains uncommitted tracked changes."
fi

if [[ "$mode" == "validate" ]]; then
  base_sha="$(git rev-parse HEAD)"
  upstream_sha="$(fetch_upstream)"

  write_output "base_sha" "$base_sha"
  write_output "upstream_sha" "$upstream_sha"

  if git merge-base --is-ancestor "$upstream_sha" "$base_sha"; then
    write_output "update_available" "false"
    write_output "tree_sha" ""
    write_summary "✅ This deployment already contains the latest official update."
    exit 0
  fi

  if ! git merge-base "$base_sha" "$upstream_sha" >/dev/null; then
    fail "This repository no longer shares Git history with the official Nightscout for Cloudflare repository."
  fi

  merge_upstream "$upstream_sha"
  tree_sha="$(git rev-parse 'HEAD^{tree}')"

  write_output "update_available" "true"
  write_output "tree_sha" "$tree_sha"
  write_summary "🔎 An official update was found and merged in a read-only validation job."
  exit 0
fi

expected_base_sha="${NSCF_BASE_SHA:-}"
expected_upstream_sha="${NSCF_UPSTREAM_SHA:-}"
expected_tree_sha="${NSCF_TREE_SHA:-}"

if [[ -z "$expected_base_sha" || -z "$expected_upstream_sha" || -z "$expected_tree_sha" ]]; then
  fail "The validated update metadata is incomplete."
fi

current_sha="$(git rev-parse HEAD)"
if [[ "$current_sha" != "$expected_base_sha" ]]; then
  fail "The main branch changed while the update was being validated. Run the updater again."
fi

fetched_upstream_sha="$(fetch_upstream)"
if [[ "$fetched_upstream_sha" != "$expected_upstream_sha" ]]; then
  fail "A newer official update appeared during validation. Run the updater again."
fi

merge_upstream "$expected_upstream_sha"
actual_tree_sha="$(git rev-parse 'HEAD^{tree}')"
if [[ "$actual_tree_sha" != "$expected_tree_sha" ]]; then
  fail "The validated files do not match the files prepared for deployment."
fi

git push origin "HEAD:refs/heads/${default_branch}"
write_summary "✅ The deployed copy was updated. Cloudflare can now build the new main commit."
