#!/usr/bin/env bash
# Run on the DEV machine. Builds the frontend from a clean copy and packs everything the server needs:
#   release/vps-panel-<version>.tar.gz (+ .sha256)
# Secrets and data (backend/.env, backend/data) are git-ignored, so they are never packed; the check below proves it.
# Uncommitted changes to tracked files ARE included, and the version then ends in "-dirty".
# The server installs it with system/upgrade-panel.sh (see docs/UPGRADE.md).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

VERSION="$(git rev-parse --short HEAD)"
[ -z "$(git status --porcelain)" ] || VERSION="$VERSION-dirty"
VERSION="$(date +%Y%m%d)-$VERSION"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
PKG="$TMP/vps-panel-release"
mkdir -p "$PKG"

echo "==> Copying project files"
git ls-files -z --cached --others --exclude-standard \
  | while IFS= read -r -d '' f; do [ -e "$f" ] && printf '%s\0' "$f"; done \
  | tar --null -T - -cf - | tar -xf - -C "$PKG"

echo "==> Building the frontend"
(cd "$PKG/frontend" && npm ci --no-audit --no-fund && npm run build)
[ -f "$PKG/frontend/dist/index.html" ] && [ -f "$PKG/frontend/dist/login.html" ] || die "Frontend build did not produce index.html + login.html"
rm -rf "$PKG/frontend/node_modules"
printf '%s\n' "$VERSION" > "$PKG/VERSION"

echo "==> Checking that nothing private is inside"
BAD="$(cd "$PKG" && find . \( -name '.env' -o -name '.env.*' -o -name '*.db' -o -name '*.db-*' -o -name '*.pem' -o -name 'id_rsa*' -o -name 'id_ed25519*' \) ! -name '.env.example' -print)"
[ -z "$BAD" ] || die "Refusing to pack private files:
$BAD"
[ ! -e "$PKG/backend/data" ] || die "Refusing to pack backend/data"

mkdir -p "$ROOT/release"
OUT="vps-panel-$VERSION.tar.gz"
tar -czf "$ROOT/release/$OUT" -C "$TMP" vps-panel-release
(cd "$ROOT/release" && sha256sum "$OUT" > "$OUT.sha256")

echo
echo "Built: $ROOT/release/$OUT ($(du -h "$ROOT/release/$OUT" | cut -f1))"
echo "Next: docs/UPGRADE.md"
