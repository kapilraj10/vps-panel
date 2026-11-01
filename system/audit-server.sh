#!/usr/bin/env bash
# Kapil Cloud — READ-ONLY server audit (Phase 1).
#
# Collects facts about kapil-server into one report file. It changes NOTHING: no installs, no restarts,
# no config writes, no container/firewall/network changes. It never prints passwords, private keys,
# tokens, environment variables or tunnel credentials.
#
# Run as kapil on kapil-server:
#   sudo -v                          # caches your sudo password so the few read-only sudo checks below can run
#   bash ~/vps-panel/system/audit-server.sh
# Then read the report it prints the path of, and share it (it is mode 600).
set -u
TS=$(date +%Y%m%d-%H%M%S)
OUT="${HOME}/kapil-cloud-audit-${TS}.txt"
umask 077
exec > >(tee "$OUT") 2>&1

section() { printf '\n==================== %s ====================\n' "$1"; }
run() { printf '\n$ %s\n' "$*"; timeout 30 "$@" 2>&1 | head -n "${LINES_MAX:-80}" || true; }
# sudo only for read-only commands, and only if sudo is already authorised (never prompts)
srun() { printf '\n$ sudo %s\n' "$*"; if sudo -n true 2>/dev/null; then timeout 30 sudo -n "$@" 2>&1 | head -n "${LINES_MAX:-80}" || true; else echo "(skipped: run 'sudo -v' first)"; fi; }
have() { command -v "$1" >/dev/null 2>&1; }

section "host"
run hostnamectl
run uname -a
run uptime
run nproc
run lscpu
LINES_MAX=40 run cat /proc/meminfo
run free -h
run swapon --show
printf '\n$ cat /proc/pressure/memory /proc/pressure/cpu /proc/pressure/io\n'
for f in memory cpu io; do printf '%s: ' "$f"; cat "/proc/pressure/$f" 2>/dev/null | tr '\n' ' '; echo; done
run cat /proc/loadavg
run df -hT -x tmpfs -x devtmpfs -x squashfs -x overlay
run lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINTS
run findmnt /mnt/backup
run systemd-detect-virt
printf '\n$ virtualization support (for future KVM nodes)\n'; grep -Eoc '(vmx|svm)' /proc/cpuinfo; ls -l /dev/kvm 2>&1

section "LXD"
if have lxc; then
  run snap list lxd
  run lxc version
  printf '\n$ lxc query /1.0 (server version + selected extensions)\n'
  lxc query /1.0 2>/dev/null | python3 -c 'import sys,json; m=json.load(sys.stdin); e=m.get("environment",{}); print("server_version", e.get("server_version")); print("storage", e.get("storage"), e.get("storage_version")); print("kernel", e.get("kernel_version")); ext=set(m.get("api_extensions",[])); [print(x, x in ext) for x in ["instance_rebuild","instances","container_exec_recording","network_leases","resources","projects"]]' 2>&1
  run lxc list --format csv -c nsN4tSl
  run lxc storage list
  run lxc network list
  run lxc profile list
  run lxc profile show default
  run lxc project list
  printf '\n$ per-instance limits and security keys (no environment/user.* keys printed)\n'
  for i in $(lxc list --format csv -c n 2>/dev/null); do
    echo "--- $i"
    for k in limits.cpu limits.memory limits.memory.swap limits.processes security.privileged security.nesting security.protection.delete boot.autostart image.description; do
      printf '  %-28s %s\n' "$k" "$(lxc config get "$i" "$k" 2>/dev/null)"
    done
    lxc config device show "$i" 2>/dev/null | sed 's/^/  /'
    printf '  state: '; lxc query "/1.0/instances/$i/state" 2>/dev/null | python3 -c 'import sys,json; s=json.load(sys.stdin); m=s.get("memory",{}); print(s.get("status"), "mem_usage", m.get("usage"), "mem_peak", m.get("usage_peak"), "swap", m.get("swap_usage"), "disk", {k:v.get("usage") for k,v in (s.get("disk") or {}).items()}, "procs", s.get("processes"))' 2>&1
    printf '  snapshots: '; lxc query "/1.0/instances/$i/snapshots" 2>/dev/null | python3 -c 'import sys,json; print(len(json.load(sys.stdin)))' 2>&1
  done
  for p in $(lxc storage list --format csv 2>/dev/null | cut -d, -f1); do run lxc storage info "$p"; done
else
  echo "lxc not found"
fi
run getent group lxd

section "Docker"
if have docker; then
  run docker version --format 'client {{.Client.Version}} server {{.Server.Version}}'
  run docker info --format 'containers={{.Containers}} running={{.ContainersRunning}} images={{.Images}} driver={{.Driver}} cgroup={{.CgroupVersion}} rootless={{.SecurityOptions}}'
  run docker ps -a --format '{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
  run docker volume ls --format '{{.Name}}\t{{.Driver}}'
  run docker network ls --format '{{.Name}}\t{{.Driver}}'
  run docker system df
fi
run getent group docker
run ls -l /var/run/docker.sock

section "PM2 (names/status only, no env)"
if have pm2; then
  pm2 jlist 2>/dev/null | python3 -c 'import sys,json; d=sys.stdin.read(); d=d[d.find("["):]; [print(p["name"], p["pm2_env"].get("status"), "restarts", p["pm2_env"].get("restart_time"), "mem", p.get("monit",{}).get("memory"), "cwd", p["pm2_env"].get("pm_cwd")) for p in json.loads(d)]' 2>&1
fi
run systemctl list-units 'pm2*' --no-pager

section "panel"
run git -C "$HOME/vps-panel" log --oneline -3
run git -C "$HOME/vps-panel" status --short
printf '\n$ panel .env keys (names only, values hidden)\n'; sed -E 's/=.*$/=<set>/; /^#/d; /^$/d' "$HOME/vps-panel/backend/.env" 2>&1
printf '\n$ panel DB: schema + users (no password hashes)\n'
(cd "$HOME/vps-panel/backend" 2>/dev/null && node -e '
const D=require("better-sqlite3"); const d=new D("data/panel.db",{readonly:true});
const t=d.prepare("select name from sqlite_master where type=\x27table\x27").all().map(r=>r.name); console.log("tables:", t.join(" "));
const cols=d.prepare("pragma table_info(users)").all().map(c=>c.name); console.log("users columns:", cols.join(" "));
const sel=cols.filter(c=>["id","username","role","container_name","status"].includes(c)).join(",");
console.log(d.prepare("select "+sel+" from users").all());
if (t.includes("schema_migrations")) console.log("migrations:", d.prepare("select version from schema_migrations").all());
console.log("audit rows:", d.prepare("select count(*) n from audit").get().n);' 2>&1)
run ls -la "$HOME/vps-panel/backend/data"

section "backups"
srun /usr/local/sbin/panel-backup disk-status
srun /usr/local/sbin/panel-backup list
run systemctl list-timers panel-backup.timer --no-pager
run ls -l /etc/sudoers.d/

section "Nginx (server names + listeners only)"
if have nginx; then
  run ls -l /etc/nginx/sites-enabled/
  srun nginx -t
  printf '\n$ server_name / listen / proxy_pass lines\n'
  grep -RhoE '^\s*(server_name|listen|proxy_pass)\s+[^;]+' /etc/nginx/sites-enabled/ /etc/nginx/conf.d/ 2>/dev/null | sed 's/^\s*//' | sort | uniq
fi

section "Cloudflare Tunnel (no credentials)"
run systemctl status cloudflared --no-pager -n 0
printf '\n$ cloudflared mode\n'
if [ -f /etc/cloudflared/config.yml ]; then echo "locally-managed config at /etc/cloudflared/config.yml:"; grep -E '^\s*(tunnel|- hostname|hostname|service)' /etc/cloudflared/config.yml 2>&1
else systemctl cat cloudflared 2>/dev/null | grep -E 'ExecStart' | sed -E 's/--token[= ][^ ]+/--token <hidden>/g'; echo "(no /etc/cloudflared/config.yml: probably remotely-managed in the dashboard)"; fi
run cloudflared --version

section "network + firewall (read only)"
run ip -brief addr
run ip route
run ss -tlnH
srun ufw status verbose
srun nft list ruleset
LINES_MAX=40 srun iptables -S

section "SSH (effective config, selected keys)"
printf '\n$ sudo sshd -T | selected keys\n'
if sudo -n true 2>/dev/null; then sudo -n sshd -T 2>/dev/null | grep -Ei '^(port|permitrootlogin|passwordauthentication|pubkeyauthentication|kbdinteractiveauthentication|allowusers|allowgroups|maxauthtries|x11forwarding) '; else echo "(skipped: run 'sudo -v' first)"; fi
srun fail2ban-client status

section "services"
run systemctl --failed --no-pager
run systemctl is-active snap.lxd.daemon docker nginx cloudflared ssh panel-backup.timer
run journalctl -p err -n 30 --no-pager --since "24 hours ago"

section "done"
echo "Report: $OUT"
