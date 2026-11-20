# CI/CD

| Workflow | When | What |
|---|---|---|
| `CI` (`.github/workflows/ci.yml`) | every push to other branches (e.g. `kapil-cloud`) and every pull request | backend e2e tests, helper tests, frontend build |
| `Deploy` (`.github/workflows/deploy.yml`) | push to `main` (merged pull request) | CI, then deploy to the panel in the variable `DEPLOY_TARGET` (`staging` = cloude.sampannatech.online, the default; `production` = panel.kapilrajkc.com.np) |
| `Deploy` → Run workflow | by hand | CI, then deploy to the panel you pick |

Deploys run `system/deploy.sh`, which builds a release, sends it over the Cloudflare SSH tunnel and runs
`system/upgrade-panel.sh` on the server (the old version is kept; if the new one does not come up it rolls back by itself).

Same thing from the dev PC: `bash system/deploy.sh staging` (or `production`, or add `--check` to change nothing).

## One-time setup

1. Server: add the deploy key to kapil's `~/.ssh/authorized_keys` (public key `~/.ssh/kapil_cloud_deploy.pub` on the dev PC).
2. GitHub → repo → Settings → Secrets and variables → Actions → New repository secret:
   - `DEPLOY_SSH_KEY` = contents of `~/.ssh/kapil_cloud_deploy` (the private key, on the dev PC)
   - `DEPLOY_KNOWN_HOSTS` = `ssh.gyannportal.com ssh-ed25519 AAAA…` (the server's host key)
   - `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` only if ssh.gyannportal.com gets a Cloudflare Access policy.
3. Optional: GitHub → Settings → Environments → `production` → Required reviewers = you, so a production deploy waits for a click.

Without `DEPLOY_SSH_KEY` the Deploy workflow runs the tests and skips the deploy with a warning.
