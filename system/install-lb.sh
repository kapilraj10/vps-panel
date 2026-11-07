#!/usr/bin/env bash
# Prepares Nginx for Kapil Cloud replicas / load balancing. Safe to run again.
#
#   sudo bash system/install-lb.sh            # do it
#   sudo bash system/install-lb.sh --check    # only report what would change
#
# What it does (nothing else):
#   1. tar backup of /etc/nginx to /root/nginx-backup-<time>.tgz
#   2. /etc/nginx/kapil-cloud/         owned by the panel user (the panel writes app-<name>.conf files here)
#   3. /etc/nginx/conf.d/kapil-cloud.conf   one line: include /etc/nginx/kapil-cloud/*.conf;   (only if missing)
#   4. /var/log/nginx/kapil-cloud/     access logs the panel reads for traffic charts + logrotate rule
#   5. /etc/sudoers.d/kapil-cloud-nginx     panel user may run exactly: nginx -t, systemctl reload nginx
#   6. nginx -t. If it fails, steps 2-5 are undone and nginx is NOT reloaded.
# It does not install Nginx, open firewall ports, or touch existing sites.
set -euo pipefail

PANEL_USER="${PANEL_USER:-kapil}"
CONF_DIR=/etc/nginx/kapil-cloud
INCLUDE=/etc/nginx/conf.d/kapil-cloud.conf
LOG_DIR=/var/log/nginx/kapil-cloud
SUDOERS=/etc/sudoers.d/kapil-cloud-nginx
LOGROTATE=/etc/logrotate.d/kapil-cloud-nginx
STATUS_PORT="${LB_STATUS_PORT:-18089}"
CHECK=0
[ "${1:-}" = "--check" ] && CHECK=1

say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run it with sudo: sudo bash $0"
id "$PANEL_USER" >/dev/null 2>&1 || die "User $PANEL_USER does not exist (PANEL_USER=<name> to change it)"
NGINX="$(command -v nginx || true)"
[ -n "$NGINX" ] || die "Nginx is not installed. Install it first (sudo apt install -y nginx), check your existing sites still work, then run this again."
SYSTEMCTL="$(command -v systemctl)"
grep -Eq 'include\s+/etc/nginx/conf\.d/\*\.conf' /etc/nginx/nginx.conf \
  || die "/etc/nginx/nginx.conf does not include conf.d/*.conf inside http {}. Add 'include /etc/nginx/kapil-cloud/*.conf;' there by hand, then run this again."
if ss -ltnH "sport = :$STATUS_PORT" | grep -q .; then
  die "Port $STATUS_PORT (Nginx status page for the panel) is already in use. Pick another: LB_STATUS_PORT=<port> sudo -E bash $0, and set the same LB_STATUS_PORT in backend/.env"
fi
"$NGINX" -t >/dev/null 2>&1 || die "nginx -t already fails BEFORE any change. Fix the existing config first: sudo nginx -t"

say "Nginx $("$NGINX" -v 2>&1 | sed 's/.*nginx\///')  ·  panel user: $PANEL_USER"
[ -d "$CONF_DIR" ] && echo "  $CONF_DIR exists" || echo "  will create $CONF_DIR"
[ -f "$INCLUDE" ] && echo "  $INCLUDE exists" || echo "  will create $INCLUDE"
[ -f "$SUDOERS" ] && echo "  $SUDOERS exists (will be refreshed)" || echo "  will create $SUDOERS"
[ "$CHECK" -eq 1 ] && { echo; echo "Check only: nothing changed."; exit 0; }

STAMP="$(date +%Y%m%d-%H%M%S)"
say "Backing up /etc/nginx to /root/nginx-backup-$STAMP.tgz"
tar -czf "/root/nginx-backup-$STAMP.tgz" -C /etc nginx
chmod 600 "/root/nginx-backup-$STAMP.tgz"

CREATED=()
undo() {
  echo "Undoing changes…" >&2
  for p in "${CREATED[@]}"; do rm -rf "$p"; done
}

say "Creating folders"
if [ ! -d "$CONF_DIR" ]; then install -d -o "$PANEL_USER" -g "$(id -gn "$PANEL_USER")" -m 755 "$CONF_DIR"; CREATED+=("$CONF_DIR"); fi
chown "$PANEL_USER:$(id -gn "$PANEL_USER")" "$CONF_DIR"
if [ ! -d "$LOG_DIR" ]; then install -d -o root -g adm -m 755 "$LOG_DIR"; CREATED+=("$LOG_DIR"); fi
if [ ! -f "$INCLUDE" ]; then
  printf '# Kapil Cloud load balancer sites (written by the panel)\ninclude %s/*.conf;\n' "$CONF_DIR" > "$INCLUDE"
  chmod 644 "$INCLUDE"
  CREATED+=("$INCLUDE")
fi

say "sudo rule: $PANEL_USER may run '$NGINX -t' and '$SYSTEMCTL reload nginx' only"
TMP="$(mktemp)"
printf '# Kapil Cloud: validate + reload nginx after the panel changes a load balancer\n%s ALL=(root) NOPASSWD: %s -t, %s reload nginx\n' "$PANEL_USER" "$NGINX" "$SYSTEMCTL" > "$TMP"
visudo -cf "$TMP" >/dev/null || { rm -f "$TMP"; undo; die "sudoers rule did not validate"; }
[ -f "$SUDOERS" ] || CREATED+=("$SUDOERS")
install -o root -g root -m 440 "$TMP" "$SUDOERS"
rm -f "$TMP"

cat > "$LOGROTATE" <<EOF
$LOG_DIR/*.log {
    daily
    rotate 7
    missingok
    notifempty
    compress
    delaycompress
    create 0644 root adm
    sharedscripts
    postrotate
        [ -s /run/nginx.pid ] && kill -USR1 \$(cat /run/nginx.pid)
    endscript
}
EOF

say "Testing the full Nginx configuration"
if ! "$NGINX" -t; then undo; die "nginx -t failed after the change; everything above was undone. Nginx was not reloaded."; fi
"$SYSTEMCTL" reload nginx

say "Done"
cat <<EOF
  Panel .env (backend/.env) defaults already match; only set these if you changed something:
    LB_CONF_DIR=$CONF_DIR
    LB_LOG_DIR=$LOG_DIR
    LB_STATUS_PORT=$STATUS_PORT
    NGINX_TEST=sudo -n $NGINX -t
    NGINX_RELOAD=sudo -n $SYSTEMCTL reload nginx
  Check from the panel user:  sudo -n $NGINX -t && echo ok
  Then restart the panel:     pm2 restart vps-panel
  Undo everything: sudo rm -rf $CONF_DIR $INCLUDE $SUDOERS $LOGROTATE && sudo nginx -t && sudo systemctl reload nginx
  Backup of /etc/nginx: /root/nginx-backup-$STAMP.tgz
EOF
