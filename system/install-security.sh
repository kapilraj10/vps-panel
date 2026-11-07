#!/usr/bin/env bash
# Installs (or updates) the Kapil Cloud security helper: firewall (UFW) + fail2ban control and the security check.
#   sudo bash system/install-security.sh            install/update the helper and its sudoers line
#   sudo bash system/install-security.sh --tools    also apt install ufw and fail2ban (UFW stays OFF until you turn it on)
# Safe to run again. It never enables the firewall by itself.
set -euo pipefail

PANEL_USER="${PANEL_USER:-kapil}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER=/usr/local/sbin/kapil-security
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run it with sudo: sudo bash $0 $*"
id "$PANEL_USER" >/dev/null 2>&1 || die "User $PANEL_USER does not exist (PANEL_USER=<name> to change it)"
[ -x /usr/bin/node ] || die "/usr/bin/node not found. Install it first: sudo apt install -y nodejs"
for f in kapil-security kapil-security.sudoers; do [ -f "$HERE/$f" ] || die "Missing $HERE/$f"; done

if [ "${1:-}" = "--tools" ]; then
  echo "==> Installing ufw and fail2ban"
  apt-get install -y ufw fail2ban
  systemctl enable --now fail2ban || true
fi

echo "==> Installing $HELPER"
install -o root -g root -m 0755 "$HERE/kapil-security" "$HELPER"
# The shebang must find a root-owned node, not one from a user's PATH
sed -i '1s|^#!.*|#!/usr/bin/node|' "$HELPER"

echo "==> Allowing $PANEL_USER to run only $HELPER as root"
TMP="$(mktemp)"; trap 'rm -f "$TMP"' EXIT
sed "s/^kapil /$PANEL_USER /" "$HERE/kapil-security.sudoers" > "$TMP"
visudo -cf "$TMP" >/dev/null || die "The sudoers file did not pass visudo. Nothing was installed."
install -o root -g root -m 0440 "$TMP" /etc/sudoers.d/kapil-security
visudo -c >/dev/null || { rm -f /etc/sudoers.d/kapil-security; die "sudo config check failed; removed /etc/sudoers.d/kapil-security again"; }
sudo -u "$PANEL_USER" sudo -n "$HELPER" status >/dev/null || die "$PANEL_USER still cannot run the helper with sudo -n"

echo "Done. Open the panel: Security center. UFW state now:"
ufw status 2>/dev/null | head -3 || echo "(ufw not installed: run again with --tools)"
