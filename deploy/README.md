# Deployment

Production runs on a single VPS (Ubuntu 24.04, arm64) with Docker Compose.
Caddy and Postgres are shared infrastructure in `infra/`; each project joins
two networks from its own compose file. Real secrets exist only in `.env`
files on the VPS and never enter this repository.

## Layout on the VPS

| Path | Contents |
| --- | --- |
| `/opt/webhook-hub` | a clone of this repository, branch `main`, updated with `git pull --ff-only` |
| `/opt/webhook-hub/deploy/infra/.env` | the real secrets for infra: ignored by git, mode 600, never committed |
| `/opt/webhook-hub/deploy/webhook-hub/.env` | the real secrets for the application, same rules |

There is no second copy of the deployment files: infra and the application run
straight from the clone, so the VPS cannot drift from the repository and only
reviewed `main` runs.

## infra

`infra/compose.yaml` runs:

- **Caddy**: terminates TLS (Let's Encrypt, HTTP-01 on port 80) and forwards to
  the application. Only TCP 80 and 443 are published; UDP 443 (HTTP/3) is not
  open in the OCI security list or the host firewall.
- **Postgres 17**: no published ports. `infra/initdb/10-webhook-hub.sh` creates
  the `webhook_hub` role and database on first start (an empty data directory).
  Every project gets its own role and database, and only that role can connect
  to its database.

Both services have memory limits (Caddy 64 MB, Postgres 512 MB) and rotated
logs.

### Networks

| Network | Members | Purpose |
| --- | --- | --- |
| `edge` | Caddy and every application | Caddy forwards requests to applications |
| `db` | Postgres and every application | applications reach the database |

Caddy is not on `db`, so the internet-facing container cannot reach Postgres.
`db` is `internal`: containers on it have no route out of the host unless they
are also on another network.

An application's compose file joins both as external networks and reaches the
database at host `postgres`, port 5432:

```yaml
networks:
  edge: { external: true }
  db: { external: true }
```

Service names on `edge` and `db` are shared by every project, so give each
project's service a unique name (the application is `webhook-hub`, which is
the name the Caddyfile forwards to).

### First start

1. Clone the repository (the repository is public, so no credentials are
   needed). Check `git --version` first and install git with apt if it is
   missing:

   ```bash
   sudo mkdir -p /opt/webhook-hub && sudo chown "$USER": /opt/webhook-hub
   git clone https://github.com/pengcc/webhook-hub.git /opt/webhook-hub
   ```

2. In `/opt/webhook-hub/deploy/infra`, create `.env` from `.env.example` with
   real passwords (`openssl rand -base64 24`) and restrict it with
   `chmod 600 .env`.
3. Optional dry run of certificate issuance: set `ACME_CA` in `.env` to the
   Let's Encrypt staging directory (append the line once; how Compose
   treats a duplicated key was not tested), start, check, then delete that
   line and run `sudo docker compose up -d` again, which recreates only
   Caddy. Staging certificates are not trusted by browsers.
4. From `/opt/webhook-hub/deploy/infra`: `sudo docker compose up -d`.
5. Check: `sudo docker compose ps`, and `curl -I https://lab-2026.duckdns.org`.
   Until the application runs, Caddy answers 502 once it has a certificate
   (confirmed on the VPS), and `http://` redirects to https with a 308.

### Updating

```bash
cd /opt/webhook-hub && git pull --ff-only
cd deploy/infra && sudo docker compose up -d
```

If the Caddyfile changed, also run `sudo docker compose up -d --force-recreate
caddy`: it is bind-mounted as a single file, and git replaces files by writing
a new one, so a running Caddy can keep reading the old one.

Never run `git clean -x` in the clone: it deletes git-ignored files, including
`.env`.

The hostname is set in `infra/Caddyfile`. Changing it later means editing that
file and the dashboard's `VITE_API_BASE`; the certificate is issued again.

### Adding another project's database

The init script runs only on an empty data directory, so a project added later
needs its role and database created by hand. Type the password when prompted
so it never appears in a command line or the shell history (replace
`newproj`; generate the password with `openssl rand -base64 24`):

```bash
read -rs PW && export PW
sudo --preserve-env=PW docker compose exec -T -e PW postgres psql -U postgres -v ON_ERROR_STOP=1 <<'SQL'
\getenv password PW
CREATE ROLE newproj LOGIN PASSWORD :'password';
CREATE DATABASE newproj OWNER newproj;
REVOKE CONNECT ON DATABASE newproj FROM PUBLIC;
SQL
unset PW
```

The `REVOKE` matters: by default every role may connect to every database.

### If the first initialisation fails

Check `sudo docker compose logs postgres`. A failed init script is not run
again: after a restart Postgres starts normally on the partly initialised data
directory, without the role and database, and the application reports
"password authentication failed". While the volume holds no data you care
about, start over from `/opt/webhook-hub/deploy/infra`:

```bash
sudo docker compose down
sudo docker volume rm infra_pgdata
sudo docker compose up -d
```

### Notes

- Postgres initialisation runs once. Changing `WEBHOOK_HUB_DB_PASSWORD` in `.env`
  later does not change the role's password; do that with `ALTER ROLE`.
- Do not run `netfilter-persistent save` after Docker is installed: it would
  write Docker's own rules into `/etc/iptables/rules.v4`.
- Not covered yet: a read-only database role for the dashboard API, and
  backups (`pg_dump` with a restore drill).
- Verified locally on a throwaway stack: the network split, the init script and
  the add-a-database procedure (without `sudo`), and the Caddyfile default and
  override for `ACME_CA`.
- Verified on the VPS (2026-11-27): steps 1 and 3 to 5 above, including
  `git clone`, the staging dry run, the switch to the production CA, a
  certificate for `lab-2026.duckdns.org` and the 502 and 308 answers from
  outside, and the init script's output (role, database, `REVOKE`). Step 2
  was done differently: `.env` was written with `umask 077` and two
  `openssl rand -hex 24` passwords. Passwords from `openssl rand -base64 24`
  (step 2 as written) have not been tried on the VPS.
- Not verified: the add-a-database procedure on the VPS (`sudo
  --preserve-env`), and the single-file bind mount behaviour after a
  `git pull`.

## webhook-hub

`webhook-hub/compose.yaml` runs the application. It needs `infra` running first:
it joins the external networks `edge` (Caddy forwards to the service name
`webhook-hub`, port 3000) and `db` (Postgres, host `postgres`). It publishes no
port, so the only way in is through Caddy. The image is built on the VPS from
the clone's `Dockerfile`, so no registry is involved. The service applies the
migrations in `migrations/` when it starts.

Settings (see `webhook-hub/.env.example`): the database password and the
Shopify webhook secret come from `.env`. `TRUST_PROXY=1` is set in the compose
file because exactly one proxy, Caddy, is in front: the rate limit then keys on
the address Caddy saw and ignores an `X-Forwarded-For` value the client wrote.
`CORS_ALLOWED_ORIGINS` is empty (no CORS headers) until the dashboard's origin
is known.

### First start

1. `infra` is running (`sudo docker compose ps` in `deploy/infra`).
2. In `/opt/webhook-hub/deploy/webhook-hub`, create `.env`. The database
   password is copied from the infra `.env` without printing it, and the
   Shopify secret is a random test value until there is a Shopify store:

   ```bash
   umask 077
   grep '^WEBHOOK_HUB_DB_PASSWORD=' ../infra/.env > .env
   printf 'SHOPIFY_WEBHOOK_SECRET=%s\n' "$(openssl rand -hex 32)" >> .env
   ```

3. Build and start: `sudo docker compose up -d --build`.
4. Check: `sudo docker compose ps` shows `healthy`, and
   `curl -sS https://lab-2026.duckdns.org/healthz` answers `{"status":"ok"}`.

### Updating

```bash
cd /opt/webhook-hub && git pull --ff-only
cd deploy/webhook-hub && sudo docker compose up -d --build
```

### Notes

- Verified locally on a throwaway stack (networks `edge` and `db`, a temporary
  Postgres, a Caddy in front, test values): the required-variable errors, the
  image build, a healthy container, the migrations applying over the `db`
  network with the password from `PGPASSWORD`, no published ports, the memory
  limit and restart policy, `/healthz` and `/events` through the proxy, and
  that 63 requests with 63 different spoofed `X-Forwarded-For` values hit the
  limit (60 allowed, then 429) with no proxy warning in the log.
- Not verified: any of it on the VPS (the image build on arm64 with the VPS's
  memory, and the `.env` commands above), the real Shopify signature header
  against a Shopify store, and `TRUST_PROXY=1` behind the production Caddy
  rather than a local one.
