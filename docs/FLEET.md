# VPS Fleet: multiple servers, agents, SSH console, monitoring, network diagnostics

The panel (on the main VPS) is the **control plane**. Every other VPS is a **managed node** running a small agent.
Apps on the nodes never depend on the panel: if the panel is down, nodes keep running; the agents just keep reconnecting.

```
 browser ──HTTPS──► Cloudflare ──tunnel──► panel 127.0.0.1:4000 (main VPS)
                                              ▲   ▲          │
             agents dial OUT (wss /agent/v1)  │   │          └── SSH (panel key) ──► node:22   (console + Test SSH only)
   Kathmandu Main (local agent) ──────────────┘   │
   Tulsi Super / Remote VPS n (agent) ────────────┘    nodes open NO inbound port for the agent
```

## What each part does

| Part | File | Notes |
|---|---|---|
| Agent | `agent/kapil-agent.js` | One file, no dependencies, Node.js 22+. Measures from `/proc`, `statfs`, `os`, the Docker socket, `pm2 jlist`. Fixed operations only (no "run a command"). |
| Installer | `agent/install-agent.sh`, served at `/agent/v1/install.sh` | Downloads the agent from the panel and **checks its SHA-256** (baked into the served script), creates a systemd unit, enrolls. |
| Registry, status, uptime, metrics | `backend/nodes.js` | `/api/nodes`, `/api/fleet/*`, agent WebSocket `/agent/v1/connect`, enrollment `POST /agent/v1/enroll` |
| SSH console + Test SSH | `backend/sshconsole.js` | `/api/ssh/*`, `/api/nodes/:id/ssh/*`, Socket.IO `ssh:*` events |
| Network diagnostics + matrix | `backend/nettests.js` | `/api/nettests`, `/api/net-matrix`, `/api/net-targets` |
| PM2 / Docker on nodes | `backend/fleetops.js` | `/api/fleet/pm2`, `/api/fleet/docker`, `/api/nodes/:id/pm2…`, `/api/nodes/:id/docker…` |

Tables (migration 5): `nodes`, `node_metrics` (per minute), `node_metrics_hourly`, `node_incidents`, `network_tests`,
`network_targets`, `terminal_sessions`, `terminal_commands`. Agent heartbeats are not stored one by one: they are averaged
per minute; per-minute rows are kept `node_metrics_minute_hours` (48 h), hourly averages `node_metrics_hourly_days` (90 d),
network tests `net_tests_keep_days` (30 d). All configurable on the Settings API.

## Status: never from the database record

| Status | Meaning |
|---|---|
| Online / Degraded | heartbeat within `node_offline_seconds` (45 s). Degraded = RAM or any disk ≥ 95 %, or load per core ≥ 2 |
| Agent disconnected | agent enrolled but silent; the SSH port still answers (TCP probe from the panel) |
| Offline | agent enrolled but silent and the SSH port does not answer |
| Reachable, no agent / Unreachable | no agent yet; SSH port answers / does not answer |
| Maintenance | set by an admin; no alerts, not counted as downtime |

Offline/unreachable/agent-disconnected open an **incident** and an **alert**; recovery closes both. Uptime % (24 h / 7 d / 30 d)
= time not in an offline/unreachable incident since the node was first seen. New alerts can also go to a webhook
(`notify_webhook_url`, Slack/Discord/ntfy compatible). **Email is not implemented** (needs an SMTP account; decision D4).

## Adding a server

1. **VPS Fleet → Add server**: name, provider, location, public IP, SSH port/user (and a private IP + network name if
   servers share a LAN; the matrix then pings private IPs).
2. **Agent tab → Create install command**, run it on the server as root. It needs Node.js 22+:
   ```bash
   curl -fsSL https://panel.gyannportal.com/agent/v1/install.sh | sudo bash -s -- --master https://panel.gyannportal.com --token kce_…
   ```
   Options: `--user kapil` (run as that user, required to see/manage *that user's* PM2), `--docker` (docker group:
   root-equivalent), `--manage-pm2`, `--manage-docker` (allow actions; default read-only). The token works once, for 1 hour.
3. **SSH tab**: add the panel's public key to `~/.ssh/authorized_keys` of the SSH user, then **Test SSH** (pins the host key).
   The console is then available.

**Cloudflare Access:** if the panel hostname is behind Access, agents cannot log in. Add an Access application or policy
that **bypasses** `panel.gyannportal.com/agent/*` (the agent endpoints authenticate themselves: one-time token, then a
256-bit node key stored hashed).

**The main VPS itself:** register it like any other server and install the agent there too, with
`--master http://127.0.0.1:4000` (loopback, no tunnel) and `--user kapil` so it sees kapil's PM2.

Remove an agent: `curl -fsSL https://<panel>/agent/v1/install.sh | sudo bash -s -- --uninstall`, then remove the server
in the panel (or "Revoke key").

## Security model

* Agent: authenticates with a per-node key (only `sha256(key)` stored); one live connection per node; disabled/revoked nodes
  are refused. The agent only accepts a fixed list of operations and validates their arguments itself. PM2/Docker
  **actions** need the node's own config to allow them, so a compromised panel cannot restart things on a read-only node.
  Default service user `kapil-agent`: no shell, `NoNewPrivileges`, `ProtectSystem=full`, 150 MB / 20 % CPU caps.
* Network tests: ping/traceroute/TCP/HTTP targets must be a registered server or an **authorized target** (super admin).
* SSH: the panel's ed25519 private key is stored AES-256-GCM encrypted and never sent to the browser. Host keys are pinned on
  the first successful Test SSH; a changed key is refused until a super admin explicitly forgets it. Console = super admin only,
  idle timeout (`terminal_idle_minutes`), max length (`terminal_max_minutes`), at most 8 per user, survives a browser drop for
  2 minutes (same user only). Every session is in `terminal_sessions`; typed command lines in `terminal_commands`
  **except input typed right after a password/passphrase prompt**. This is best-effort keystroke capture (tab completion and
  history recall are not expanded); it is an audit aid, not a tamper-proof record.
* Everything a user does is in the audit log (`node_*`, `ssh_*`, `nettest_*`, `pm2_*`, `docker_*`, `agent_*`).

## Testing

`backend/test/fleet.test.js` runs the real agent file as two nodes against a real panel process, a real SSH server (ssh2),
fake PM2 and a fake Docker API: enrollment, wrong keys, measured facts vs `os`, metric buckets, agent loss → agent_disconnected →
offline → recovery with incidents/alerts/uptime, maintenance, connect/disconnect, ping/TCP/HTTP/traceroute/DNS from agents,
target authorization, the matrix, PM2/Docker read-only vs managed nodes, SSH host-key pinning and change detection, console I/O,
password-safe command audit, reattach, installer checksum. The speed test is not run in CI (it would use the internet);
it uses the same Cloudflare method as the panel's existing speed test.

## Not built yet (honest list)

* **Cross-server replicas and global traffic switching.** Replicas + Nginx load balancing work on the panel's own host
  (docs/HOST_APPS.md). Spreading one app over several VPS needs deployment through agents plus a routing layer: Nginx on one
  box (a single point of failure), or Cloudflare Load Balancing (paid add-on). Not claimed until built and tested.
* **Backups across servers** (node → main / remote storage, restore to another node).
* Remote Docker create/remove/images, Compose deploys, container exec terminal on nodes.
* Agent self-update (re-run the installer for now; the panel shows each agent's version).
* Email notifications (needs SMTP), server map, DEVELOPER/VIEWER roles, 2FA.
