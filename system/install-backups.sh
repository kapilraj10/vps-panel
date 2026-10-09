#!/usr/bin/env bash
# Installs (or updates) the vps-panel backup helper, its sudoers entry and the systemd timer.
#
#   First time, also mounts the HDD at /mnt/backup:  sudo bash system/install-backups.sh --uuid <HDD-UUID>
#   Later (update the helper, re-check everything):  sudo bash system/install-backups.sh
#
# Find the HDD's UUID with: lsblk -f
# Safe to run again: it never overwrites existing settings and refuses to touch the SSD.
set -euo pipefail

PANEL_USER="${PANEL_USER:-kapil}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MNT=/mnt/backup
HELPER=/usr/local/sbin/panel-backup

say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }
# The physical disk a device lives on (follows partitions, LVM, crypt)
disk_of() { lsblk -nsro NAME,TYPE "$1" | awk '$2 == "disk" { print $1; exit }'; }

UUID=""
while [ $# -gt 0 ]; do
  case "$1" in
    --uuid) UUID="${2:-}"; shift 2 || die "--uuid needs a value" ;;
    --uuid=*) UUID="${1#*=}"; shift ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *) die "Unknown option: $1 (see --help)" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "Run it with sudo: sudo bash $0${UUID:+ --uuid $UUID}"
id "$PANEL_USER" >/dev/null 2>&1 || die "User $PANEL_USER does not exist (run with PANEL_USER=<name> to change it)"
PANEL_GROUP="$(id -gn "$PANEL_USER")"
[ -x /usr/bin/node ] || die "/usr/bin/node not found. Install it first: sudo apt install -y nodejs"
for f in panel-backup panel-backup.sudoers panel-backup.service panel-backup.timer config.example.json; do
  [ -f "$HERE/$f" ] || die "Missing $HERE/$f. Copy the whole vps-panel folder to the server first."
done

say "Checking tools"
if ! command -v rsync >/dev/null || ! command -v smartctl >/dev/null; then
  apt-get install -y rsync smartmontools
fi

# ---------- backup disk ----------
if [ -n "$UUID" ]; then
  say "Setting up the HDD (UUID $UUID) at $MNT"
  [[ "$UUID" =~ ^[A-Za-z0-9-]+$ ]] || die "\"$UUID\" does not look like a UUID. Copy it from: lsblk -f"
  DEV="$(blkid -U "$UUID")" || die "No disk has UUID $UUID. Check: lsblk -f"
  FSTYPE="$(blkid -s TYPE -o value "$DEV")"
  [ "$FSTYPE" = ext4 ] || die "$DEV is \"$FSTYPE\", not ext4. Nothing was changed."
  ROOT_DISK="$(disk_of "$(findmnt -n -o SOURCE /)")"
  [ -n "$ROOT_DISK" ] && [ "$(disk_of "$DEV")" = "$ROOT_DISK" ] && die "$DEV is on the same disk as / (the SSD). Nothing was changed."

  if findmnt -n --mountpoint "$MNT" >/dev/null; then
    [ "$(findmnt -n -o SOURCE --mountpoint "$MNT")" = "$DEV" ] || die "Something else is already mounted at $MNT"
    echo "$DEV is already mounted at $MNT"
  else
    mkdir -p "$MNT"
    [ -z "$(ls -A "$MNT")" ] || die "$MNT has files in it but no disk is mounted (they are on the SSD). Move them away first."
    # Read-only while unmounted: nothing can ever land on the SSD if the HDD is missing
    chattr +i "$MNT"
    if grep -qE "^[[:space:]]*[^#[:space:]]+[[:space:]]+$MNT[[:space:]]" /etc/fstab; then
      grep -qE "^[[:space:]]*UUID=$UUID[[:space:]]+$MNT[[:space:]]" /etc/fstab \
        || die "/etc/fstab already has a different line for $MNT. Fix or remove it, then run this again."
    else
      cp /etc/fstab "/etc/fstab.before-panel-backup.$(date +%Y%m%d%H%M%S)"
      echo "UUID=$UUID $MNT ext4 defaults,nofail,noatime 0 2" >> /etc/fstab
      echo "Added $MNT to /etc/fstab (a copy of the old file is next to it)"
    fi
    systemctl daemon-reload
    mount "$MNT"
  fi
fi

findmnt -n --mountpoint "$MNT" >/dev/null \
  || die "Nothing is mounted at $MNT. Run again with: sudo bash $0 --uuid <HDD-UUID>   (find it with: lsblk -f)"
[ "$(stat -c %d "$MNT")" != "$(stat -c %d /)" ] || die "$MNT is on the same device as / (the SSD)"
findmnt "$MNT"

# ---------- helper, settings, state folder ----------
say "Installing the helper at $HELPER"
install -o root -g root -m 0755 "$HERE/panel-backup" "$HELPER"
install -d -o root -g "$PANEL_GROUP" -m 2750 /var/lib/panel-backup /var/lib/panel-backup/jobs /var/lib/panel-backup/logs
install -d -o root -g root -m 0755 /etc/panel-backup
if [ -f /etc/panel-backup/config.json ]; then
  echo "Keeping the existing settings in /etc/panel-backup/config.json"
else
  install -o root -g root -m 0644 "$HERE/config.example.json" /etc/panel-backup/config.json
  echo "Installed default settings"
fi

# ---------- sudoers ----------
say "Allowing $PANEL_USER to run only $HELPER as root"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
sed "s/^kapil /$PANEL_USER /" "$HERE/panel-backup.sudoers" > "$TMP"
visudo -cf "$TMP" >/dev/null || die "The sudoers file did not pass visudo. Nothing was installed."
install -o root -g root -m 0440 "$TMP" /etc/sudoers.d/panel-backup
visudo -c >/dev/null || { rm -f /etc/sudoers.d/panel-backup; die "sudo config check failed; removed /etc/sudoers.d/panel-backup again"; }
sudo -u "$PANEL_USER" sudo -n "$HELPER" get-config >/dev/null || die "$PANEL_USER still cannot run the helper with sudo -n"
echo "OK: $PANEL_USER can run the helper without a password"

# ---------- disk marker ----------
say "Marking the backup disk"
"$HELPER" init-disk | grep -v '^@@'

# ---------- systemd ----------
say "Installing the daily timer"
install -o root -g root -m 0644 "$HERE/panel-backup.service" "$HERE/panel-backup.timer" /etc/systemd/system/
systemctl daemon-reload
"$HELPER" set-config < /etc/panel-backup/config.json >/dev/null
systemctl list-timers panel-backup.timer --no-pager

say "Done. Next steps (as $PANEL_USER, not root):"
cat <<EOF
  cd ~/vps-panel/frontend && npm run build
  pm2 restart vps-panel
  sudo panel-backup run --dry-run
EOF
