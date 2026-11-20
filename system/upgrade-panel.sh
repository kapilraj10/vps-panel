#!/usr/bin/env bash
# Replaces the running panel with this release. Same folder, same PM2 name, same .env (port, secrets),
# same database, so the Cloudflare route and domain keep working untouched. Run as the panel user, NOT with sudo.
# A .env set through DOTENV_CONFIG_PATH in PM2, or a DB_PATH outside backend/data, stays where it is.
#
#   bash system/upgrade-panel.sh --check      Checks only. Changes nothing.
#   bash system/upgrade-panel.sh              Upgrade. If the new version is not healthy, the old one comes back by itself.
#   bash system/upgrade-panel.sh --rollback   Go back to the version kept by the last upgrade.
#   bash system/upgrade-panel.sh --cleanup    Delete the kept old versions (after this, --rollback is impossible).
#
# Settings (environment): PM2_NAME (vps-panel), APP_DIR (from PM2, else ~/vps-panel), HEALTH_WAIT (60 seconds),
# PANEL_DOMAIN (the panel's public hostname; empty skips the domain check).
#
# Touches only the panel: other PM2 apps, containers, Nginx, the firewall and Cloudflare are left alone.
set -euo pipefail

PM2_NAME="${PM2_NAME:-vps-panel}"
HEALTH_WAIT="${HEALTH_WAIT:-60}"
PANEL_DOMAIN="${PANEL_DOMAIN-}"
RELEASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_ROOT="$HOME/panel-predeploy"
TS="$(date +%Y%m%d-%H%M%S)"

say() { printf '\n==> %s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

MODE=upgrade
case "${1:-}" in
  "") ;;
  --check) MODE=check ;;
  --rollback) MODE=rollback ;;
  --cleanup) MODE=cleanup ;;
  -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
  *) die "Unknown option: $1 (see --help)" ;;
esac

# ---------- helpers ----------
# "<cwd>\t<script>\t<DOTENV_CONFIG_PATH>" of the PM2 process, empty if PM2 does not know it
pm2_info() {
  pm2 jlist 2>/dev/null | PM2_NAME="$PM2_NAME" node -e '
    let d = ""; process.stdin.on("data", (c) => d += c).on("end", () => {
      const list = JSON.parse(d.slice(d.indexOf("[")) || "[]");
      const p = list.find((x) => x.name === process.env.PM2_NAME);
      if (p) console.log(`${p.pm2_env.pm_cwd}\t${p.pm2_env.pm_exec_path}\t${p.pm2_env.DOTENV_CONFIG_PATH || ""}`);
    });' || true
}

env_get() { # file key -> value without quotes (last one wins, like dotenv)
  { grep -E "^[[:space:]]*$2=" "$1" 2>/dev/null || true; } | tail -n 1 | sed -E "s/^[^=]*=//; s/^[\"']//; s/[\"'][[:space:]]*$//; s/[[:space:]]+$//"
}

env_set() { # file key value: fills an empty KEY= line, or appends
  if grep -qE "^$2=" "$1"; then sed -i -E "s|^$2=.*|$2=$3|" "$1"
  else [ -z "$(tail -c 1 "$1")" ] || echo >> "$1"; echo "$2=$3" >> "$1"; fi
}

http_code() { curl -s -o /dev/null --max-time 5 -w '%{http_code}' "$1" 2>/dev/null || true; }

load_target() {
  command -v pm2 >/dev/null || die "pm2 not found in PATH"
  local info cwd script dotenv=""
  info="$(pm2_info)"
  PM2_KNOWN=no
  if [ -n "$info" ]; then
    PM2_KNOWN=yes
    IFS=$'\t' read -r cwd script dotenv <<< "$info"
    case "$script" in
      */backend/server.js) ;;
      *) die "PM2 app \"$PM2_NAME\" runs $script, expected .../backend/server.js. Set PM2_NAME if the panel has another name." ;;
    esac
    APP_DIR="${script%/backend/server.js}"
    # dotenv reads .env from the working directory
    [ "$cwd" = "$APP_DIR/backend" ] || die "PM2 app \"$PM2_NAME\" has working directory $cwd, expected $APP_DIR/backend"
  else
    APP_DIR="${APP_DIR:-$HOME/vps-panel}"
  fi
  ENV_EXTERNAL=no
  ENV_FILE="$APP_DIR/backend/.env"
  if [ -n "$dotenv" ]; then
    case "$dotenv" in /*) ;; *) die "DOTENV_CONFIG_PATH of \"$PM2_NAME\" must be an absolute path, got: $dotenv" ;; esac
    ENV_FILE="$dotenv"; ENV_EXTERNAL=yes
  fi
  [ -f "$ENV_FILE" ] || die "$ENV_FILE not found. This script upgrades an existing install."
  PORT="$(env_get "$ENV_FILE" PORT)"; PORT="${PORT:-4000}"
  HOST="$(env_get "$ENV_FILE" HOST)"; HOST="${HOST:-127.0.0.1}"
  case "$HOST" in 0.0.0.0|::|'[::]') HOST=127.0.0.1 ;; esac
  URL="http://$HOST:$PORT"
}

load_db() {
  DB_EXTERNAL=no
  DB_DIR="$APP_DIR/backend/data"
  DB_PATH="$(env_get "$ENV_FILE" DB_PATH)"
  [ -n "$DB_PATH" ] || return 0
  case "$DB_PATH" in /*) ;; *) DB_PATH="$APP_DIR/backend/$DB_PATH" ;; esac
  DB_PATH="$(realpath -m "$DB_PATH")"
  case "$DB_PATH" in "$DB_DIR"/*) return 0 ;; esac
  DB_EXTERNAL=yes
  DB_DIR="$(dirname "$DB_PATH")"
  # The whole folder is saved and restored, so it must be a folder of its own
  case "$APP_DIR/" in "$DB_DIR"/*) die "DB_PATH folder $DB_DIR contains the panel. Give the database its own folder." ;; esac
  case "$HOME/" in "$DB_DIR"/*) die "DB_PATH folder $DB_DIR contains your home folder. Give the database its own folder." ;; esac
  [ "$DB_DIR" != "$HOME" ] && [ "$DB_DIR" != / ] || die "DB_PATH folder $DB_DIR is too broad. Give the database its own folder."
}

# Puts back the .env and database that live outside the panel folder, as saved by upgrade <ts>
restore_external() {
  local saved="$BACKUP_ROOT/$1"
  if [ "$ENV_EXTERNAL" = yes ] && [ -f "$saved/env" ]; then cp -p "$saved/env" "$ENV_FILE"; fi
  if [ "$DB_EXTERNAL" = yes ] && [ -f "$saved/db.tar.gz" ]; then
    [ ! -e "$DB_DIR" ] || mv "$DB_DIR" "$saved/db-replaced-$TS"
    tar -xzf "$saved/db.tar.gz" -C "$(dirname "$DB_DIR")"
  fi
}

# Kept copies, newest last
kept_old() { compgen -G "$APP_DIR.old-*" | sort || true; }

pm2_up() { # starts the panel from APP_DIR
  if [ "$PM2_KNOWN" = yes ]; then pm2 restart "$PM2_NAME" >/dev/null
  else (cd "$APP_DIR/backend" && pm2 start server.js --name "$PM2_NAME" >/dev/null); PM2_KNOWN=yes; fi
}

pm2_down() { if [ "$PM2_KNOWN" = yes ]; then pm2 stop "$PM2_NAME" >/dev/null; fi; }

wait_for_panel() { # "health" also needs /healthz (older versions only have /login)
  local need="$1" i code
  for ((i = 0; i < HEALTH_WAIT; i += 2)); do
    code="$(http_code "$URL/login")"
    if [ "$code" = 200 ] || [ "$code" = 302 ]; then
      [ "$need" != health ] && return 0
      curl -s --max-time 5 "$URL/healthz" 2>/dev/null | grep -q '"ok":true' && return 0
    fi
    sleep 2
  done
  return 1
}

show_log() { echo "--- last lines of the panel log ---"; pm2 logs "$PM2_NAME" --lines 30 --nostream 2>&1 | tail -n 40 || true; }

# Puts "$1" back as the live folder. The folder being replaced is kept as "$2".
restore_old() {
  local old="$1" aside="$2"
  pm2_down || true
  restore_external "${old##*.old-}"
  [ ! -e "$APP_DIR" ] || mv "$APP_DIR" "$aside"
  mv "$old" "$APP_DIR"
  pm2_up
  if wait_for_panel login; then pm2 save >/dev/null 2>&1 || true; return 0; fi
  return 1
}

# ---------- cleanup ----------
if [ "$MODE" = cleanup ]; then
  load_target
  OLD="$(compgen -G "$APP_DIR.old-*" || true)"
  EXTRA="$(compgen -G "$APP_DIR.failed-*" || true; compgen -G "$APP_DIR.rolledback-*" || true)"
  [ -n "$OLD$EXTRA" ] || { echo "No old versions to delete."; exit 0; }
  [ "$(http_code "$URL/login")" != 000 ] || die "The panel is not answering on $URL. Not deleting anything while it is down."
  printf 'Will permanently delete:\n%s\n' "$(printf '%s\n%s\n' "$OLD" "$EXTRA" | sed '/^$/d; s/^/  /')"
  echo "Kept: $BACKUP_ROOT (.env + database from before each upgrade). After this, --rollback is not possible."
  printf 'Type DELETE to continue: '
  read -r ANSWER || ANSWER=""
  [ "$ANSWER" = DELETE ] || die "Nothing deleted."
  printf '%s\n%s\n' "$OLD" "$EXTRA" | sed '/^$/d' | while IFS= read -r d; do
    case "$d" in "$APP_DIR".old-*|"$APP_DIR".failed-*|"$APP_DIR".rolledback-*) rm -rf -- "$d" ;; esac
  done
  echo "Old versions deleted."
  exit 0
fi

# ---------- rollback ----------
if [ "$MODE" = rollback ]; then
  load_target
  load_db
  OLD="$(kept_old | tail -n 1)"
  [ -n "$OLD" ] || die "No old version kept next to $APP_DIR, nothing to roll back to."
  if [ "$DB_EXTERNAL" = yes ] && [ ! -f "$BACKUP_ROOT/${OLD##*.old-}/db.tar.gz" ]; then
    die "The saved database $BACKUP_ROOT/${OLD##*.old-}/db.tar.gz is missing, so the old version cannot get its old database back."
  fi
  echo "Going back to: $OLD"
  echo "Current folder is kept as: $APP_DIR.rolledback-$TS"
  echo "Note: the old database comes back too. Changes made since that upgrade stay only in the kept folder."
  printf 'Type ROLLBACK to continue: '
  read -r ANSWER || ANSWER=""
  [ "$ANSWER" = ROLLBACK ] || die "Nothing changed."
  restore_old "$OLD" "$APP_DIR.rolledback-$TS" || { show_log; die "The old version did not come up on $URL."; }
  echo "Rolled back. The panel is answering on $URL."
  exit 0
fi

# ---------- checks (nothing changes here) ----------
say "Checking"
[ "$(id -u)" -ne 0 ] || die "Do not use sudo. PM2 belongs to the panel user."
for t in node npm curl tar openssl; do command -v "$t" >/dev/null || die "$t is not installed"; done
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "Node $(node -v) is too old: better-sqlite3 needs Node 20 or newer."
[ -f "$RELEASE_DIR/backend/server.js" ] && [ -f "$RELEASE_DIR/backend/package-lock.json" ] || die "$RELEASE_DIR is not a release folder"
[ -f "$RELEASE_DIR/frontend/dist/index.html" ] && [ -f "$RELEASE_DIR/frontend/dist/login.html" ] \
  || die "This folder has no built frontend. Use the tar.gz from system/make-release.sh."
load_target
[ -d "$APP_DIR" ] || die "$APP_DIR not found"
case "$RELEASE_DIR/" in "$APP_DIR"/*) die "Run this from the unpacked release folder, not from inside $APP_DIR." ;; esac

load_db

NEED_KB=$(( $(du -sk "$RELEASE_DIR" | cut -f1) + 500000 ))
[ ! -d "$DB_DIR" ] || NEED_KB=$(( NEED_KB + 2 * $(du -sk "$DB_DIR" | cut -f1) ))
FREE_KB="$(df -Pk "$(dirname "$APP_DIR")" | awk 'NR==2 {print $4}')"
[ "$FREE_KB" -ge "$NEED_KB" ] || die "Not enough disk space: need about $((NEED_KB / 1024)) MB, have $((FREE_KB / 1024)) MB."

OLD_VERSION="$(cat "$APP_DIR/VERSION" 2>/dev/null || git -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
NEW_VERSION="$(cat "$RELEASE_DIR/VERSION" 2>/dev/null || echo unknown)"
printf '  Folder:   %s\n  Settings: %s\n  Database: %s\n  PM2 app:  %s (%s)\n  Address:  %s (from .env)\n  Version:  %s -> %s\n  Answering now: HTTP %s\n' \
  "$APP_DIR" "$ENV_FILE" "$DB_DIR" "$PM2_NAME" "$([ "$PM2_KNOWN" = yes ] && echo found || echo 'not in PM2, will be added')" \
  "$URL" "$OLD_VERSION" "$NEW_VERSION" "$(http_code "$URL/login")"
if [ -d "$APP_DIR/.git" ] && [ -n "$(git -C "$APP_DIR" status --porcelain 2>/dev/null)" ]; then
  warn "the server copy has local edits. They will NOT be in the new version (the old folder keeps them):"
  git -C "$APP_DIR" status --short | head -n 20
fi
if [ "$MODE" = check ]; then echo; echo "All checks passed. Nothing was changed."; exit 0; fi

# ---------- prepare the new version while the old one keeps running ----------
STAGING="$APP_DIR.new-$TS"
OLD_KEPT="$APP_DIR.old-$TS"
PHASE=staging
on_exit() {
  local rc=$?
  trap - EXIT INT TERM HUP
  if [ "$PHASE" != done ] && [ "$rc" -ne 0 ]; then
    case "$PHASE" in
      staging) rm -rf -- "$STAGING"; echo "Nothing was changed. The old version is still running." ;;
      stopped) rm -rf -- "$STAGING"; pm2_up || true
        if wait_for_panel login; then echo "The old version is running again."; else echo "The old version did not come back: $URL. Check: pm2 logs $PM2_NAME"; fi ;;
      swapped)
        show_log
        say "Bringing the old version back"
        if restore_old "$OLD_KEPT" "$APP_DIR.failed-$TS"; then
          echo "The old version is running again on $URL, with its old database."
          echo "The failed attempt is kept in $APP_DIR.failed-$TS"
        else echo "The old version did not come up either. Check: pm2 logs $PM2_NAME"; fi ;;
    esac
  fi
  exit "$rc"
}
trap on_exit EXIT
trap 'exit 130' INT TERM HUP

say "Preparing the new version (the old one keeps running)"
cp -a "$RELEASE_DIR" "$STAGING"
rm -rf -- "$STAGING/backend/node_modules" "$STAGING/backend/data" "$STAGING/backend/.env"
(cd "$STAGING/backend" && npm ci --omit=dev --no-audit --no-fund) || die "npm ci failed"
sqlite_ok() { (cd "$STAGING/backend" && node -e 'new (require("better-sqlite3"))(":memory:").close()') >/dev/null 2>&1; }
if ! sqlite_ok; then
  echo "better-sqlite3 is not ready, rebuilding it"
  (cd "$STAGING/backend" && { npm install-scripts approve better-sqlite3 >/dev/null 2>&1 || true; npm rebuild better-sqlite3; }) || true
  sqlite_ok || die "better-sqlite3 cannot load. Install compilers and try again: sudo apt install -y build-essential python3"
fi

# ---------- switch: the only part with downtime ----------
say "Stopping the old version"
pm2_down
PHASE=stopped
if [ "$(http_code "$URL/login")" != 000 ]; then
  die "Something else still answers on $URL after stopping $PM2_NAME. Find it with: ss -ltnp | grep :$PORT"
fi

say "Saving .env and database to $BACKUP_ROOT/$TS"
( umask 077
  mkdir -p "$BACKUP_ROOT/$TS"
  cp -p "$ENV_FILE" "$BACKUP_ROOT/$TS/env"
  [ ! -d "$DB_DIR" ] || tar -czf "$BACKUP_ROOT/$TS/db.tar.gz" -C "$(dirname "$DB_DIR")" "$(basename "$DB_DIR")"
  echo "$OLD_VERSION" > "$BACKUP_ROOT/$TS/old-version"
)
chmod 700 "$BACKUP_ROOT"

say "Copying .env and database into the new version"
NEW_ENV="$ENV_FILE"
if [ "$ENV_EXTERNAL" = no ]; then
  NEW_ENV="$STAGING/backend/.env"
  cp -p "$ENV_FILE" "$NEW_ENV"
  chmod 600 "$NEW_ENV"
fi
if [ "$DB_EXTERNAL" = no ] && [ -d "$DB_DIR" ]; then cp -a "$DB_DIR" "$STAGING/backend/data"; fi

[ -n "$(env_get "$NEW_ENV" SESSION_SECRET)" ] || { env_set "$NEW_ENV" SESSION_SECRET "$(openssl rand -hex 32)"; echo "Added SESSION_SECRET to .env"; }
if [ -z "$(env_get "$NEW_ENV" SECRETS_KEY)" ]; then
  # A database that already ran Kapil Cloud may hold secrets sealed with the key derived from SESSION_SECRET.
  # A new key would make those unreadable, so only add one before the first Kapil Cloud start.
  DB_FILE="${DB_PATH:-$DB_DIR/panel.db}"
  ALREADY="$(cd "$STAGING/backend" && DB_FILE="$DB_FILE" node -e '
    const fs = require("fs");
    if (!fs.existsSync(process.env.DB_FILE)) { console.log("no"); process.exit(0); }
    const d = new (require("better-sqlite3"))(process.env.DB_FILE, { readonly: true });
    console.log(d.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get("schema_migrations") ? "yes" : "no");' 2>/dev/null || echo unknown)"
  if [ "$ALREADY" = no ]; then env_set "$NEW_ENV" SECRETS_KEY "$(openssl rand -hex 32)"; echo "Added SECRETS_KEY to .env"
  else echo "Leaving SECRETS_KEY unset: this database may already hold secrets sealed with the derived key."; fi
fi

say "Replacing the old version"
mv "$APP_DIR" "$OLD_KEPT"
PHASE=swapped
mv "$STAGING" "$APP_DIR"

say "Starting the new version (the database upgrades itself on first start)"
pm2_up
wait_for_panel health || die "The new version did not become healthy on $URL within ${HEALTH_WAIT}s."
# A process that answers once and then crashes must not count as healthy
sleep 5
wait_for_panel health || die "The new version stopped answering on $URL."
pm2 save >/dev/null 2>&1 || warn "pm2 save failed. Run it by hand so the panel survives a reboot."
PHASE=done

# ---------- report ----------
say "Upgrade done: $OLD_VERSION -> $NEW_VERSION, on $URL"
HEALTH="$(curl -s --max-time 5 "$URL/healthz" || true)"
echo "  Health: $HEALTH"
case "$HEALTH" in *'"lxd":false'*) warn "the panel cannot reach LXD yet. Check group membership: id | grep lxd (then: sudo systemctl restart pm2-$USER)" ;; esac

USERS="$(cd "$APP_DIR/backend" && DB_FILE="${DB_PATH:-$DB_DIR/panel.db}" node -e '
  const d = new (require("better-sqlite3"))(process.env.DB_FILE, { readonly: true });
  console.log(d.prepare("SELECT COUNT(*) n FROM users").get().n);' 2>/dev/null || echo "?")"
[ "$USERS" != 0 ] || warn "there are no users yet. Create one: cd $APP_DIR/backend && node scripts/create-user.js"

if [ -n "$PANEL_DOMAIN" ]; then
  CODE="$(http_code "https://$PANEL_DOMAIN/login")"
  case "$CODE" in
    000|5*) warn "https://$PANEL_DOMAIN gives HTTP $CODE. The panel itself is healthy, so check cloudflared and the tunnel route (must stay http://localhost:$PORT)." ;;
    *) echo "  Domain: https://$PANEL_DOMAIN answers HTTP $CODE" ;;
  esac
fi

HELPER=/usr/local/sbin/panel-backup
if [ -f "$HELPER" ] && ! cmp -s "$HELPER" "$APP_DIR/system/panel-backup"; then
  warn "the installed backup helper differs from this release. To update it: sudo bash $APP_DIR/system/install-backups.sh"
fi

EXTRA_FILES="$(cd "$OLD_KEPT" && find . \( -name node_modules -o -name .git -o -path ./frontend/dist -o -path ./backend/data \) -prune -o -type f -print \
  | while IFS= read -r f; do [ -e "$APP_DIR/$f" ] || echo "$f"; done | head -n 20)"
if [ -n "$EXTRA_FILES" ]; then
  warn "these files are in the old version but not the new one. If you need any of them, copy them before --cleanup:"
  printf '%s\n' "$EXTRA_FILES" | sed 's/^/  /'
fi

cat <<EOF

Old version is no longer running. It is kept for rollback at: $OLD_KEPT
Log in and check the panel, then delete the old version:
  PM2_NAME=$PM2_NAME bash $APP_DIR/system/upgrade-panel.sh --cleanup
Problem? Go back:
  PM2_NAME=$PM2_NAME bash $APP_DIR/system/upgrade-panel.sh --rollback
EOF
