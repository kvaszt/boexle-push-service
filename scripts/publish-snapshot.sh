#!/usr/bin/env bash
#
# publish-snapshot.sh
#
# Builds a clean, single-commit snapshot of the current HEAD and force-pushes
# it to the public GitHub mirror. The private development history is NOT
# exposed — only the tree of tracked files at HEAD is included, as one
# orphan commit tagged with the given version.
#
# Usage:
#   ./scripts/publish-snapshot.sh v1.2.3
#
# Requirements:
#   - git remote named "public" pointing at the public repository
#   - working tree is clean (no uncommitted changes)
#   - current branch is the one you want to snapshot (typically main)

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <version-tag>    (e.g. v1.0.0)" >&2
  exit 1
fi

VERSION="$1"

if ! [[ "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$ ]]; then
  echo "error: version must match vMAJOR.MINOR.PATCH (e.g. v1.0.0)" >&2
  exit 1
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

if ! git remote get-url public >/dev/null 2>&1; then
  echo "error: no git remote named 'public' configured." >&2
  echo "hint:  git remote add public git@github.com:kvaszt/boexle-push-service.git" >&2
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "error: working tree is not clean. Commit or stash changes first." >&2
  exit 1
fi

PUBLIC_URL="$(git remote get-url public)"
HEAD_SHA="$(git rev-parse HEAD)"
HEAD_SHORT="$(git rev-parse --short HEAD)"

echo "→ Publishing snapshot ${VERSION}"
echo "  source commit: ${HEAD_SHORT}"
echo "  target remote: ${PUBLIC_URL}"

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

# Export only tracked files at HEAD. Untracked and ignored files (.env, certs,
# *.db, node_modules, dist, …) are automatically excluded because git-archive
# only emits what is under version control.
git archive --format=tar HEAD | tar -x -C "$TMPDIR"

# Strip development-only plumbing that is irrelevant to the transparency
# purpose (CI pipelines, pre-commit hooks, etc.) and that also triggers
# extra GitHub token scopes on push (e.g. `workflow`).
rm -rf "$TMPDIR/.github/workflows"
if [[ -d "$TMPDIR/.github" ]] && [[ -z "$(ls -A "$TMPDIR/.github" 2>/dev/null)" ]]; then
  rmdir "$TMPDIR/.github"
fi

cd "$TMPDIR"
git init -q -b main
AUTHOR_NAME="$(git -C "$REPO_ROOT" config user.name)"
AUTHOR_EMAIL="$(git -C "$REPO_ROOT" config user.email)"
git config user.name  "$AUTHOR_NAME"
git config user.email "$AUTHOR_EMAIL"
git add -A

# Use git plumbing instead of `git commit` so that no shell-wrapper can inject
# trailers (e.g. "Made-with: ...") into the published commit message.
TREE_SHA="$(git write-tree)"
COMMIT_SHA="$(
  GIT_AUTHOR_NAME="$AUTHOR_NAME"     GIT_AUTHOR_EMAIL="$AUTHOR_EMAIL" \
  GIT_COMMITTER_NAME="$AUTHOR_NAME"  GIT_COMMITTER_EMAIL="$AUTHOR_EMAIL" \
  git commit-tree "$TREE_SHA" -m "Release ${VERSION} — public reference snapshot"
)"
git update-ref refs/heads/main "$COMMIT_SHA"
git tag -a "${VERSION}" -m "Release ${VERSION}" "$COMMIT_SHA"

git remote add origin "${PUBLIC_URL}"
git push --force origin main
git push --force origin "refs/tags/${VERSION}"

echo
echo "✓ Snapshot ${VERSION} published."
echo "  The private repository history remains untouched."
