#!/usr/bin/env bash

set -euo pipefail

cd "$(dirname "$0")/.."

upstream_repo="PrimeIntellect-ai/prime-agent"
main_branch="main"
merge_current=false

usage() {
	cat <<'EOF'
Usage: ./scripts/sync-upstream.sh [--merge-current]

Synchronize this GitHub fork and local main branch with
PrimeIntellect-ai/prime-agent.

Options:
  --merge-current  Merge the refreshed main branch into the current branch.
  -h, --help       Show this help text.
EOF
}

while [[ $# -gt 0 ]]; do
	case "$1" in
		--merge-current)
			merge_current=true
			shift
			;;
		-h | --help)
			usage
			exit 0
			;;
		*)
			printf 'error: unknown option: %s\n' "$1" >&2
			usage >&2
			exit 1
			;;
	esac
done

if ! command -v gh >/dev/null 2>&1; then
	printf 'error: GitHub CLI (gh) is required.\n' >&2
	exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
	printf 'error: the worktree must be clean before syncing upstream.\n' >&2
	exit 1
fi

current_branch=$(git branch --show-current)
if [[ -z "$current_branch" ]]; then
	printf 'error: cannot sync from a detached HEAD.\n' >&2
	exit 1
fi

fork_repo=$(gh repo view --json nameWithOwner --jq '.nameWithOwner')
parent_repo=$(gh repo view --json parent --jq '.parent | select(.) | "\(.owner.login)/\(.name)"')
if [[ "$parent_repo" != "$upstream_repo" ]]; then
	printf 'error: %s is not a fork of %s.\n' "$fork_repo" "$upstream_repo" >&2
	exit 1
fi

printf 'Syncing %s:%s from %s...\n' "$fork_repo" "$main_branch" "$upstream_repo"
gh repo sync "$fork_repo" --source "$upstream_repo" --branch "$main_branch"
git fetch origin "$main_branch"

if git show-ref --verify --quiet "refs/heads/$main_branch"; then
	if [[ "$current_branch" == "$main_branch" ]]; then
		git merge --ff-only "origin/$main_branch"
	elif git merge-base --is-ancestor "$main_branch" "origin/$main_branch"; then
		git branch --force "$main_branch" "origin/$main_branch"
	else
		printf 'error: local %s has commits that are not in origin/%s.\n' "$main_branch" "$main_branch" >&2
		printf 'Resolve that divergence manually before updating the local branch.\n' >&2
		exit 1
	fi
else
	git branch --track "$main_branch" "origin/$main_branch"
fi

if [[ "$merge_current" == "true" && "$current_branch" != "$main_branch" ]]; then
	git merge --no-edit "$main_branch"
fi

printf 'Fork and local %s are synchronized at %s.\n' "$main_branch" "$(git rev-parse --short "$main_branch")"
if [[ "$merge_current" != "true" && "$current_branch" != "$main_branch" ]]; then
	printf 'Current branch %s was not changed. Re-run with --merge-current to update it.\n' "$current_branch"
fi
