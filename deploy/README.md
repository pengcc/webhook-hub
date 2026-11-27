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

There is no second copy of the deployment files: infra runs straight from the
clone, so the VPS cannot drift from the repository and only reviewed `main`
runs. The application's own compose file will live in the same clone.

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
   Let's Encrypt staging directory, start, check, then remove it and recreate
   the Caddy container. Staging certificates are not trusted by browsers.
4. From `/opt/webhook-hub/deploy/infra`: `sudo docker compose up -d`.
5. Check: `sudo docker compose ps`, and `curl -I https://lab-2026.duckdns.org`.
   Until the application runs, Caddy is expected to answer 502 once it has a
   certificate (expected, not yet confirmed).

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
- Not covered yet: the application compose file, a read-only database role for
  the dashboard API, and backups (`pg_dump` with a restore drill).
- Verified locally on a throwaway stack: the network split, the init script and
  the add-a-database procedure (without `sudo`), and the Caddyfile default and
  override for `ACME_CA`. Not verified: the commands on the VPS (including
  `git clone` and `sudo --preserve-env`) and the single-file bind mount
  behaviour after a `git pull`.
