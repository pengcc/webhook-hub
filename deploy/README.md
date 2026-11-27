# Deployment

Production runs on a single VPS (Ubuntu 24.04, arm64) with Docker Compose.
Caddy and Postgres are shared infrastructure in `infra/`; each project joins
the `edge` network from its own compose file. Real secrets exist only in `.env`
files on the VPS and never enter this repository.

## Layout on the VPS

| Path | Contents |
| --- | --- |
| `/opt/infra` | a copy of `deploy/infra/` plus a real `.env` |
| `/opt/webhook-hub` | the application compose file, added in a later step |

## infra

`infra/compose.yaml` runs:

- **Caddy**: terminates TLS (Let's Encrypt, HTTP-01 on port 80) and forwards to
  the application. Only TCP 80 and 443 are published; UDP 443 (HTTP/3) is not
  open in the OCI security list or the host firewall.
- **Postgres 17**: no published ports, reachable only on the `edge` network.
  `infra/initdb/10-webhook-hub.sh` creates the `webhook_hub` role and database
  on first start (an empty data directory). Every project gets its own role and
  database.

Both services have memory limits (Caddy 64 MB, Postgres 512 MB) and rotated
logs.

### First start

1. Copy `deploy/infra/` to `/opt/infra` on the VPS.
2. Create `/opt/infra/.env` from `.env.example` with real passwords
   (`openssl rand -base64 24`). Keep it readable by the owner only.
3. Optional dry run of certificate issuance: set `ACME_CA` in `.env` to the
   Let's Encrypt staging directory, start, check, then remove it and recreate
   the Caddy container. Staging certificates are not trusted by browsers.
4. From `/opt/infra`: `sudo docker compose up -d`.
5. Check: `sudo docker compose ps`, and `curl -I https://lab-2026.duckdns.org`.
   Until the application runs, Caddy answers 502 with a valid certificate.

The hostname is set in `infra/Caddyfile`. Changing it later means editing that
file and the dashboard's `VITE_API_BASE`; the certificate is issued again.

### Notes

- Postgres initialisation runs once. Changing `WEBHOOK_HUB_DB_PASSWORD` in `.env`
  later does not change the role's password; do that with `ALTER ROLE`.
- Do not run `netfilter-persistent save` after Docker is installed: it would
  write Docker's own rules into `/etc/iptables/rules.v4`.
- Not covered yet: the application compose file, a read-only database role for
  the dashboard API, and backups (`pg_dump` with a restore drill).
