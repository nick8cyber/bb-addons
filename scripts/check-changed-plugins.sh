#!/usr/bin/env bash
# Check only the plugins changed vs a base ref: npm test (if the plugin
# defines a "test" script) and tsc --noEmit (if it has tsconfig.json).
#
# Usage: scripts/check-changed-plugins.sh [base-ref]   (default: origin/main)
# Exit:  0 when every affected plugin passes, 1 on any failure.

set -u -o pipefail

BASE="${1:-origin/main}"

cd "$(dirname "$0")/.." || exit 1

if ! git rev-parse --verify --quiet "$BASE^{commit}" >/dev/null; then
  echo "check-changed-plugins: base ref '$BASE' not found (fetch first?)" >&2
  exit 1
fi

if ! git merge-base "$BASE" HEAD >/dev/null; then
  echo "check-changed-plugins: no merge base with $BASE" >&2
  exit 1
fi

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "check-changed-plugins: working tree is dirty — commit or stash first (only committed changes are checked)" >&2
  exit 1
fi

CHANGED=$(git diff --name-only "$BASE"...HEAD) || {
  echo "check-changed-plugins: git diff failed" >&2
  exit 1
}

PLUGIN_DIRS=()
while IFS= read -r dir; do
  [ -n "$dir" ] && PLUGIN_DIRS+=("$dir")
done <<EOF
$(printf '%s\n' "$CHANGED" | sed -n 's|^plugins/\([^/]*\)/.*$|plugins/\1|p' | sort -u)
EOF

if [ "${#PLUGIN_DIRS[@]}" -eq 0 ]; then
  echo "check-changed-plugins: no plugins affected vs $BASE — nothing to check"
  exit 0
fi

failed=()

for dir in "${PLUGIN_DIRS[@]}"; do
  name="${dir#plugins/}"
  if [ ! -f "$dir/package.json" ]; then
    echo "==> $name: no package.json — skipped"
    continue
  fi

  echo "==> $name"
  ok=1

  if [ ! -d "$dir/node_modules" ]; then
    echo "    npm ci"
    (cd "$dir" && nice -n 19 npm ci --silent) || ok=0
  fi

  if [ "$ok" -eq 1 ] && [ -n "$(cd "$dir" && npm pkg get scripts.test 2>/dev/null | grep -v '^{}')" ]; then
    echo "    npm test"
    (cd "$dir" && nice -n 19 npm test) || ok=0
  fi

  if [ "$ok" -eq 1 ] && [ -f "$dir/tsconfig.json" ]; then
    echo "    npx --no-install tsc --noEmit"
    (cd "$dir" && nice -n 19 npx --no-install tsc --noEmit) || ok=0
  fi

  if [ "$ok" -eq 1 ]; then
    echo "    $name: OK"
  else
    echo "    $name: FAILED"
    failed+=("$name")
  fi
done

if [ "${#failed[@]}" -gt 0 ]; then
  echo "check-changed-plugins: FAILED: ${failed[*]}" >&2
  exit 1
fi

echo "check-changed-plugins: all affected plugins passed (${#PLUGIN_DIRS[@]})"
exit 0
