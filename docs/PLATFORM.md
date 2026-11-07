# Databases, host terminal, Security center, two-factor login

Added 2026-11-07. All four live in the main panel process; no new daemon. The firewall/fail2ban part needs one root helper.

| Feature | Where | Who |
|---|---|---|
| Databases (PostgreSQL 15-17, MySQL 8.0/8.4, MongoDB 7/8) | Applications → Databases | admins see, super admin changes |
| Master server + host terminal | VPS Fleet → Set up master server, then SSH console | super admin |
| Security check, firewall (UFW), fail2ban, panel login blocks | Administration → Security center | admins see, super admin changes |
| Two-factor login (TOTP) | Account → Security; policy in Security center → Two-factor | everyone; policy super admin |

## Databases

Each database is a Docker container `kdb-<name>` with its own named volume `kdb-<name>-data`, created with the Docker
manager's rules (not privileged, `no-new-privileges`, no host folders, 10 MB log rotation, optional memory limit).

- **Port:** one per database from `DB_PORTS` (default `15400-15999`), published on **127.0.0.1** only, or on the LXD bridge
  address (e.g. `10.10.10.1`) when "LXD containers" access is chosen. Never `0.0.0.0`. Docker bypasses UFW, so this matters.
- **Password:** generated (144 bit), stored AES-256-GCM encrypted (`SECRETS_KEY`), shown only to a super admin under
  **Connect**, and every view is audited. MySQL also gets a separate root password (needed for backups).
- **Create** runs in the background (pull, then volume, then container). Status goes queued → pulling → creating → ready, or failed with the
  error. A failed create leaves no container behind.
- **Delete** asks for the typed name and keeps the volume. **Delete with data** removes the volume as well.
- **Backups:** the existing backup helper already dumps Postgres/MySQL/Mongo containers it finds (by image) using the official env
  variables, so these databases are in the daily backup with nothing else to do (Backups → Databases).
- From a laptop: `ssh -L 5432:127.0.0.1:<port> kapil@ssh.gyannportal.com`, then connect to `localhost:5432`.

## Master server and host terminal

**VPS Fleet → Set up master server** (super admin):

1. Creates the primary fleet server if there is none, or updates the existing one. Its name is the hostname, its location is
   **Kathmandu** (you can change it), and its address is `127.0.0.1:22` as the panel's own user.
2. Writes the panel's SSH public key into a marked block of that user's `~/.ssh/authorized_keys`. Other keys are left alone,
   and removing the block revokes access. The panel already runs as this user, and that user is in the `lxd` and `docker` groups,
   so this gives the panel no new power.
3. Runs Test SSH, which pins the host key. The **SSH console** then lists the master: that is the host terminal. Sessions and
   typed commands are recorded, except what you type after a password prompt.

Live graphs for the master need the agent on it as well. The dialog prints the `install.sh` command that uses
`--master http://127.0.0.1:<port>`.

## Security center

The root helper is `/usr/local/sbin/kapil-security` (source `system/kapil-security`, plain Node). `/etc/sudoers.d/kapil-security`
allows the panel user to run that one file. The helper has fixed subcommands, validates every argument and never uses a shell.

```bash
sudo bash <panel folder>/system/install-security.sh --tools   # installs ufw + fail2ban + the helper; UFW stays OFF
```

- **Security check:** SSH root and password login, empty passwords, MaxAuthTries, UFW, fail2ban, ports open to the internet,
  Docker ports that bypass UFW, pending (security) updates, automatic updates, reboot needed. On the panel side: `.env` mode,
  `HOST`, secure cookies, `SECRETS_KEY`, which admins have no 2FA, `STAGING_MODE`, and failed logins in the last 24 h.
- **Firewall:** list, add (allow / rate-limited allow / deny, port or range, optional source CIDR, comment) and delete rules,
  and turn UFW on or off. Lock-out guards:
  - **Turn on** first adds `limit <ssh port>/tcp` and the LXD bridge rules (`allow in on lxdbr0`, `route allow in/out on lxdbr0`),
    so containers keep DHCP, DNS and internet.
  - It refuses to deny the SSH port for everyone or for a network.
  - It refuses to delete the last rule letting SSH in while UFW is on.
  - Deny rules are inserted first, so that they take effect.
- **Bans & logins:** fail2ban jails with banned IPs, plus ban and unban. The panel's own login blocks (5 failures in 15 min) can
  be cleared.

## Two-factor login

- **Setup:** Account → Security → Set up two-factor login (password), scan the QR code, enter the code, then save the 10 recovery codes.
  Turning it on logs out your other devices.
- **Login:** password, then the code (or a recovery code). The password step only creates a 5-minute ticket with 5 tries,
  and wrong codes count toward the login IP block.
- **Storage:** the secret is encrypted, the recovery codes are SHA-256 hashed, and a code is accepted only once (no replay).
- **Lost phone:** Users → user → Two-factor → Reset (super admin). The user is logged out everywhere.
- **Policy:** Security center → Two-factor → Require it for admins. You can only turn this on after setting up your own 2FA.
  While it is on, an admin without 2FA gets 403 on every API except their account and 2FA pages, gets no live socket data,
  terminals or consoles, and only sees the Security page.

## Tests

| Suite | What |
|---|---|
| `backend/test/platform.test.js` | databases (roles, validation, create/ports/bind/env/labels, credentials audited, stop/start/logs, delete keeps volume, failed create), 2FA (setup, login, replay, recovery once, reset, policy), Security center (helper calls, guards, audit, login blocks), master setup (primary, Kathmandu, key block idempotent, other keys kept) |
| `system/test/kapil-security.test.cjs` | helper validation, ufw/fail2ban/sshd/ss parsing, SSH guard, CLI rejects bad input before running anything |
