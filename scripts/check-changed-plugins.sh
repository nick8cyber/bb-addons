#!/usr/bin/env bash
# Check only the plugins changed vs a base ref: npm test (if the plugin
# defines a "test" script) and tsc --noEmit (if it has tsconfig.json).
#
# Dependencies: `node_modules` must be a real directory carrying every
# binary the plugin's devDependencies declare — a symlink (shared store)
# or a missing .bin entry means `npm ci` runs again.
#
# Usage: scripts/check-changed-plugins.sh [base-ref]   (default: origin/main)
# Exit:  0 when every affected plugin passes, 1 on any failure.
# On failure the tail of the output lists the failed test names per
# plugin — TAP `not ok` lines and vitest `FAIL`/`×` lines; the release
# journal keeps only the tail, so the names must live there.

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

# node_modules is usable only as a real directory where every binary the
# plugin's devDependencies declare exists under .bin — a symlink or a
# missing binary (e.g. tsc) means npm ci must run.
deps_ok() {
  local dir="$1" nm="$1/node_modules"
  [ -d "$nm" ] && [ ! -L "$nm" ] || return 1
  (cd "$dir" && node -e '
    const fs = require("fs"), path = require("path");
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
    for (const dep of Object.keys(pkg.devDependencies || {})) {
      let dp;
      try {
        dp = JSON.parse(fs.readFileSync(path.join("node_modules", dep, "package.json"), "utf8"));
      } catch { process.exit(1); }
      const bin = dp.bin;
      const names = typeof bin === "string" ? [dep.split("/").pop()] : Object.keys(bin || {});
      for (const b of names) {
        if (!fs.existsSync(path.join("node_modules", ".bin", b))) process.exit(1);
      }
    }
  ')
}

failed=()
failed_tests=()

for dir in "${PLUGIN_DIRS[@]}"; do
  name="${dir#plugins/}"
  if [ ! -f "$dir/package.json" ]; then
    echo "==> $name: no package.json — skipped"
    continue
  fi

  echo "==> $name"
  ok=1

  if ! deps_ok "$dir"; then
    # a node_modules symlink points into a shared store — `npm ci`
    # would delete every entry INSIDE the link target (the store of
    # the main checkout or other worktrees). Unlink it first
    # (rm -f, never -r); npm ci then creates a real directory.
    if [ -L "$dir/node_modules" ]; then rm -f "$dir/node_modules"; fi
    echo "    npm ci"
    (cd "$dir" && nice -n 19 npm ci --silent) || ok=0
  fi

  if [ "$ok" -eq 1 ] && [ -n "$(cd "$dir" && npm pkg get scripts.test 2>/dev/null | grep -v '^{}')" ]; then
    echo "    npm test"
    test_log=$(mktemp "${TMPDIR:-/tmp}/check-plugins-test-XXXXXX.log")
    if (cd "$dir" && nice -n 19 npm test) >"$test_log" 2>&1; then
      cat "$test_log"
    else
      ok=0
      cat "$test_log"
      # Failing test names — TAP `not ok` lines and vitest
      # `FAIL`/`×`/`✗` lines — the summary below keeps them inside
      # the journal tail (nested subtests included, deduped).
      while IFS= read -r line; do
        [ -n "$line" ] && failed_tests+=("$name: $line")
      done <<EOF2
$(grep -E '^[[:space:]]*(not ok |FAIL[[:space:]]|[×✗✘][[:space:]])' "$test_log" | sed 's/^[[:space:]]*//' | sort -u)
EOF2
    fi
    rm -f "$test_log"
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
  if [ "${#failed_tests[@]}" -gt 0 ]; then
    echo "check-changed-plugins: failed tests:" >&2
    printf '    %s\n' "${failed_tests[@]}" >&2
  fi
  exit 1
fi

echo "check-changed-plugins: all affected plugins passed (${#PLUGIN_DIRS[@]})"
exit 0
