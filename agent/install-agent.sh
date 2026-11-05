#!/usr/bin/env bash
# Kapil Cloud agent installer. Served by the panel at /agent/v1/install.sh (the panel fills in the agent's SHA-256).
#
#   curl -fsSL https://<panel>/agent/v1/install.sh | sudo bash -s -- --master https://<panel> --token <one-time token> [options]
#
# Options:
#   --user <name>       run the agent as this existing user (needed to see/manage THAT user's PM2). Default: a new
#                       system user "kapil-agent" with no login shell and no home write access (monitoring only).
#   --docker            add the agent user to the "docker" group (Docker list/logs; root-equivalent, decide consciously)
#   --manage-pm2        allow PM2 start/stop/restart/... from the panel (default: read-only)
#   --manage-docker     allow container start/stop/restart from the panel (default: read-only)
#   --uninstall         stop and remove the agent (service, files, config, the kapil-agent user)
# Needs Node.js 22+ (uses its built-in WebSocket). Nothing listens on this server: the agent dials out to the panel.
set -euo pipefail

AGENT_SHA256="__AGENT_SHA256__"
MASTER="" TOKEN="" RUN_USER="" DOCKER=0 MANAGE_PM2=false MANAGE_DOCKER=false UNINSTALL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --master) MASTER="${2:-}"; shift 2 ;;
    --token) TOKEN="${2:-}"; shift 2 ;;
    --user) RUN_USER="${2:-}"; shift 2 ;;
    --docker) DOCKER=1; shift ;;
    --manage-pm2) MANAGE_PM2=true; shift ;;
    --manage-docker) MANAGE_DOCKER=true; DOCKER=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    *) echo "Unknown option $1" >&2; exit 2 ;;
  esac
done
die() { echo "ERROR: $*" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || die "run with sudo"

if [ "$UNINSTALL" -eq 1 ]; then
  systemctl disable --now kapil-agent 2>/dev/null || true
  rm -f /etc/systemd/system/kapil-agent.service && systemctl daemon-reload
  rm -rf /opt/kapil-agent /etc/kapil-agent
  id kapil-agent >/dev/null 2>&1 && userdel kapil-agent || true
  echo "Kapil Cloud agent removed. Remove the server from the panel too (or revoke its agent key there)."
  exit 0
fi

[ -n "$MASTER" ] && [ -n "$TOKEN" ] || die "--master and --token are required"
case "$MASTER" in https://*|http://127.0.0.1*|http://localhost*) ;; *) die "--master must be https:// (or http://127.0.0.1 on the panel server itself)";; esac
NODE="$(command -v node || true)"
[ -n "$NODE" ] || die "Node.js is not installed. Install Node.js 22+ first (https://nodejs.org or NodeSource), then run this again."
MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
[ "$MAJOR" -ge 22 ] || die "Node.js $("$NODE" -v) is too old; the agent needs 22 or newer."

if [ -z "$RUN_USER" ]; then
  RUN_USER=kapil-agent
  id "$RUN_USER" >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin "$RUN_USER"
  OWN_USER=1
else
  id "$RUN_USER" >/dev/null 2>&1 || die "user $RUN_USER does not exist"
  OWN_USER=0
fi
if [ "$DOCKER" -eq 1 ]; then
  getent group docker >/dev/null || die "there is no docker group (is Docker installed?)"
  usermod -aG docker "$RUN_USER"
fi

echo "==> Downloading the agent from $MASTER"
install -d -m 755 /opt/kapil-agent
TMP="$(mktemp)"
curl -fsSL "$MASTER/agent/v1/kapil-agent.js" -o "$TMP"
echo "$AGENT_SHA256  $TMP" | sha256sum -c --quiet - || { rm -f "$TMP"; die "checksum mismatch: the downloaded agent is not the one the panel announced"; }
install -m 755 -o root -g root "$TMP" /opt/kapil-agent/kapil-agent.js
rm -f "$TMP"

echo "==> Enrolling"
install -d -m 700 -o "$RUN_USER" /etc/kapil-agent
sudo -u "$RUN_USER" "$NODE" /opt/kapil-agent/kapil-agent.js enroll --master "$MASTER" --token "$TOKEN" --config /etc/kapil-agent/agent.json
sudo -u "$RUN_USER" "$NODE" -e '
  const fs = require("fs"); const f = "/etc/kapil-agent/agent.json"; const c = JSON.parse(fs.readFileSync(f, "utf8"));
  c.manage = { pm2: process.argv[1] === "true", docker: process.argv[2] === "true" };
  fs.writeFileSync(f, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });' "$MANAGE_PM2" "$MANAGE_DOCKER"

HOME_DIR="$(getent passwd "$RUN_USER" | cut -d: -f6)"
if [ "$OWN_USER" -eq 1 ]; then HARDEN="ProtectHome=true"; else HARDEN="ProtectHome=false"; fi
cat > /etc/systemd/system/kapil-agent.service <<EOF
[Unit]
Description=Kapil Cloud node agent
After=network-online.target
Wants=network-online.target

[Service]
User=$RUN_USER
Environment=HOME=$HOME_DIR
ExecStart=$NODE /opt/kapil-agent/kapil-agent.js run --config /etc/kapil-agent/agent.json
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=full
$HARDEN
PrivateTmp=true
MemoryMax=150M
CPUQuota=20%

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now kapil-agent
sleep 2
systemctl --no-pager --lines=5 status kapil-agent || true
echo
echo "Done. The server should show as Online in the panel within a few seconds."
echo "Agent user: $RUN_USER · PM2 management: $MANAGE_PM2 · Docker management: $MANAGE_DOCKER"
echo "Logs: journalctl -u kapil-agent -f    Remove: curl -fsSL $MASTER/agent/v1/install.sh | sudo bash -s -- --uninstall"
