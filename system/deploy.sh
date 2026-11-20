#!/usr/bin/env bash
# One-command deploy: build a release here, send it to the server, install it there with upgrade-panel.sh
# (automatic rollback if the new version does not come up). Used from the dev PC and by GitHub Actions.
#
#   bash system/deploy.sh staging       # cloude.sampannatech.online  (port 2026, PM2 kapil-cloud-staging)
#   bash system/deploy.sh production    # panel.kapilrajkc.com.np     (port 4000, PM2 vps-panel)
#   bash system/deploy.sh staging --check   # build + upload + checks only, changes nothing on the server
#
# Environment (all optional):
#   DEPLOY_HOST   ssh host (default ssh.gyannportal.com)      DEPLOY_USER  (default kapil)
#   DEPLOY_SSH    extra ssh options, e.g. "-i key -o ProxyCommand=..."  (CI sets these)
#   SKIP_BUILD=1  deploy the newest release/*.tar.gz instead of building one
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

TARGET="${1:-}"
CHECK="${2:-}"
case "$TARGET" in
  staging) PM2_NAME=kapil-cloud-staging; PANEL_DOMAIN=cloude.sampannatech.online ;;
  production) PM2_NAME=vps-panel; PANEL_DOMAIN=panel.kapilrajkc.com.np ;;
  *) die "Usage: bash system/deploy.sh staging|production [--check]" ;;
esac
[ -z "$CHECK" ] || [ "$CHECK" = "--check" ] || die "Unknown option: $CHECK"

HOST="${DEPLOY_HOST:-ssh.gyannportal.com}"
USER_AT="${DEPLOY_USER:-kapil}@$HOST"
# shellcheck disable=SC2206
SSH_OPTS=(-o ServerAliveInterval=30 -o ConnectTimeout=30 ${DEPLOY_SSH:-})

if [ "${SKIP_BUILD:-}" != "1" ]; then
  echo "==> Building the release"
  bash system/make-release.sh
fi
OUT="$(ls -t release/vps-panel-*.tar.gz 2>/dev/null | head -n1)"
[ -n "$OUT" ] || die "No release/*.tar.gz found"
NAME="$(basename "$OUT")"
echo "==> Deploying $NAME to $TARGET ($PANEL_DOMAIN) via $HOST"

ssh "${SSH_OPTS[@]}" "$USER_AT" 'mkdir -p ~/deploys'
scp "${SSH_OPTS[@]}" "$OUT" "$OUT.sha256" "$USER_AT:deploys/"

# Runs on the server as kapil (PM2 belongs to kapil, so never sudo). A login shell, so node/pm2 are on PATH.
ssh "${SSH_OPTS[@]}" "$USER_AT" bash -l -s -- "$NAME" "$PM2_NAME" "$PANEL_DOMAIN" "${CHECK:-}" <<'REMOTE'
set -euo pipefail
NAME="$1"; export PM2_NAME="$2" PANEL_DOMAIN="$3"; CHECK="${4:-}"
cd ~/deploys
sha256sum -c "$NAME.sha256"
rm -rf ~/vps-panel-release
tar -xzf "$NAME" -C ~
echo "==> Server: checks"
bash ~/vps-panel-release/system/upgrade-panel.sh --check
if [ "$CHECK" = "--check" ]; then echo "Check only: nothing was changed."; exit 0; fi
echo "==> Server: upgrade"
bash ~/vps-panel-release/system/upgrade-panel.sh
# keep the 5 newest uploads
ls -t ~/deploys/vps-panel-*.tar.gz 2>/dev/null | tail -n +6 | while read -r f; do rm -f -- "$f" "$f.sha256"; done
REMOTE

if [ "$CHECK" != "--check" ]; then
  echo "==> Checking https://$PANEL_DOMAIN"
  for i in $(seq 1 20); do
    code="$(curl -s -o /dev/null --max-time 10 -w '%{http_code}' "https://$PANEL_DOMAIN/login" || true)"
    [ "$code" = "200" ] && { echo "Live: https://$PANEL_DOMAIN (HTTP 200)"; exit 0; }
    sleep 3
  done
  die "https://$PANEL_DOMAIN/login did not answer 200 (last: ${code:-none}). On the server: bash ~/vps-panel-release/system/upgrade-panel.sh --rollback"
fi
