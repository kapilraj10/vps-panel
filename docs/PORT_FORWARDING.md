# Port forwarding for apps (LXD proxy devices)

cloudflared runs on the **host** and sends each public hostname to `http://localhost:<port>`. An app inside an LXD
container is not on the host's localhost, so without a forward the tunnel gets "connection refused" and visitors see
**Cloudflare 502 Bad Gateway**.

The panel now gives every app port a proxy device on the app's container (`backend/portforward.js`):

| | |
|---|---|
| device | `port<PORT>` |
| type | `proxy` |
| listen (host) | `tcp:127.0.0.1:<PORT>` (localhost only, never 0.0.0.0) |
| connect (container) | `tcp:127.0.0.1:<PORT>` |

It is the same as `lxc config device add <container> port<PORT> proxy listen=tcp:127.0.0.1:<PORT> connect=tcp:127.0.0.1:<PORT>`,
but done through the LXD REST API on the local socket the panel already uses (no shell, no sudo).

## What happens on a deploy (LXD targets: main server and own cloud servers)

```
==> Starting with PM2
==> Started. Listening on port 4023 inside the server.
==> Forwarding port 4023 (host 127.0.0.1:4023 -> apps-takcha-admin 127.0.0.1:4023)
Created proxy device port4023: listen=tcp:127.0.0.1:4023 connect=tcp:127.0.0.1:4023
==> Health check: http://127.0.0.1:4023 from the host
  HTTP 200 from http://127.0.0.1:4023 (try 1/5)
==> Public hostname: https://admin-takcha.example.com -> http://localhost:4023
DNS: CNAME admin-takcha.example.com -> <tunnel>.cfargotunnel.com (proxied by Cloudflare)
==> Deployed.
```

- **Idempotent.** If the device is already right, nothing is written. If it exists with other settings, it is updated.
  If another device in the same container already forwards 127.0.0.1:PORT to PORT (added by hand), it is left alone.
- **Conflicts.** Host ports are shared by all containers. A port another container forwards, or that a host program
  listens on, is refused when the app is created or its port is changed, and fails the deploy with a clear message.
  An app created without a port gets the next free one. Ports of common host services (MySQL, Postgres, Redis,
  MongoDB, Docker API, the panels 2026/4000, ...) are always refused, even while that service is stopped, so a
  container can never catch localhost traffic meant for the host; add more with `PORT_FORWARD_RESERVED=1234,5678`.
- **Health check.** `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:<PORT>` from the host, 5 tries 2 s apart
  (`HEALTH_TRIES`, `HEALTH_DELAY_MS`). Any HTTP status counts as up (even 404). No answer marks the deploy **failed**,
  and the log then shows the PM2 state of the app, `ss -tlnp` inside the container and whether the proxy device exists.
- **Cleanup.** A port change takes effect on the next deploy, which forwards the new port and removes `port<OLD>`.
  Deleting or moving an app removes its device (unless another app in that container uses the same port). Only
  devices shaped like the ones above are removed.
- **Routes.** App domains go to `http://localhost:<PORT>`; the panel ensures the forward before writing the tunnel
  rule and the proxied CNAME. The background route check never moves a live route to localhost while the device is
  missing. Domains for a bare server port (no app) still go to the container IP.
- **App page.** The Network card shows container, container IP, internal port, proxy device (✅ forwarded / ❌ missing),
  the tunnel target and a **Fix port forwarding** button (`POST /api/apps/:id/forward`).
- `PORT_FORWARD=off` in the panel's .env turns all of this off (old behaviour).

## One-time repair for apps deployed before this

Run on the server as the panel user, **after** the new panel version is installed:

```bash
cd /var/tmp/kapil-cloud-release/backend
DOTENV_CONFIG_PATH=/var/tmp/kapil-cloud-test/.env node scripts/forward-ports.js --dry-run   # show only
DOTENV_CONFIG_PATH=/var/tmp/kapil-cloud-test/.env node scripts/forward-ports.js --check     # create + test
```

Apps that already have a hand-made `port<PORT>` device (3022, 4022, 4023) show as "already forwarded". Safe to re-run.
