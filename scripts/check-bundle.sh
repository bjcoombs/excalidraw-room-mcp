#!/usr/bin/env bash
# Verifies that an MCP Bundle contains what the server needs at runtime and
# none of the sources it does not.
#
# With no argument it packs the working tree to a temporary bundle and checks
# that (what `npm run check:bundle` does locally). With a path it checks a
# bundle that has already been packed, so the release workflow can verify the
# exact artifact it is about to attach rather than a second pack of its own.
set -euo pipefail

# Present in the bundle or the installed server is broken. dist/view/canvas.html
# is read at resources/read time; manifest.json is how the client installs it.
required=(
  manifest.json
  dist/index.js
  dist/view/canvas.html
)

# Path prefixes that must not appear at the root of the bundle - one per
# directory .mcpbignore excludes, so an ignore-rule regression fails here rather
# than shipping. Anchored to the start of the entry name: a bundled dependency
# is free to carry its own src/ or view/ directory.
forbidden_prefixes=(
  src/
  view/
  tests/
  coverage/
  reports/
  scripts/
  .github/
  .assess/
  .claude/
  .stryker-tmp/
)

bundle=${1:-}
if [[ -z $bundle ]]; then
  bundle=$(mktemp -t excalidraw-room-mcp-XXXXXX).mcpb
  trap 'rm -f "$bundle"' EXIT
  echo "Packing $bundle"
  npx -y @anthropic-ai/mcpb pack . "$bundle" >/dev/null
fi

if [[ ! -f $bundle ]]; then
  echo "check:bundle: no such bundle: $bundle" >&2
  exit 1
fi

# -Z1 lists one entry name per line, with no header or size columns to parse.
entries=$(unzip -Z1 "$bundle")

failed=0
for path in "${required[@]}"; do
  if grep -qxF "$path" <<<"$entries"; then
    echo "ok       $path"
  else
    echo "MISSING  $path" >&2
    failed=1
  fi
done

for prefix in "${forbidden_prefixes[@]}"; do
  # Escape the dots so `.github/` cannot also match `xgithub/`.
  pattern="^$(sed 's/\./\\./g' <<<"$prefix")"
  if matches=$(grep -E "$pattern" <<<"$entries"); then
    echo "PRESENT  ${prefix} should not be in the bundle:" >&2
    sed 's/^/         /' <<<"$matches" >&2
    failed=1
  else
    echo "ok       no ${prefix} entries"
  fi
done

if (( failed )); then
  echo "check:bundle: the bundle contents are wrong" >&2
  exit 1
fi
echo "check:bundle: $bundle looks right"
