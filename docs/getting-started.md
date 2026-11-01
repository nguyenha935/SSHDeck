# Getting started

[Back to README](../README.md)

## Docker

Use the [Docker quick start](../README.md#quick-start). It runs the published image `ghcr.io/nguyenha935/sshdeck`: `latest` follows the `main` branch, and each release is also tagged with its version. The loopback binding exposes the app only on the Docker host. To build the image yourself instead, run `docker build -t sshdeck:local .` in a checkout and use `sshdeck:local` in the same command.

For access from another device, put SSHDeck behind an HTTPS reverse proxy, configure `CORS_ORIGINS` to the exact browser origin, set `SESSION_COOKIE_SECURE=true` and set `TRUSTED_PROXIES` to the number of trusted proxy hops. Keep the backend port reachable only by the proxy. See [proxy examples](configuration.md#reverse-proxy-setup).

Create the first administrator on a trusted network before exposing registration. Disable registration in Admin when additional users should be provisioned by an administrator.

## Docker Compose

The supplied [Compose file](../docker-compose.yml) builds from this checkout:

```bash
docker compose up -d --build
```

Review its defaults first: port 5000 is published on all interfaces, HTTP cookies and wildcard CORS are enabled for trusted homelab use, and tmux is enabled by default. For public access use HTTPS, replace wildcard CORS with your origin, remove `ALLOW_CORS_WILDCARD`, enable secure cookies and restrict the backend port.

The named data volume persists accounts, settings, encrypted keys and Docker's generated secret. Preserve it when replacing the container. Do not use `docker compose down -v` unless you intend to delete that data.

## Run from source

Requires Python 3.11 or newer and the dependencies in `requirements.txt`.

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

Generate a secret once with `openssl rand -hex 32`, save it as `SECRET_KEY` in your private `.env`, and retain it across restarts. Do not commit that file. For local HTTP, also set `SESSION_COOKIE_SECURE=false` and `CORS_ORIGINS=http://localhost:5000`.

```bash
python start.py
```

Source installations default to a `data` directory beside `config.py`; Docker uses `/app/data`. Run exactly one application worker. Node is needed for updating frontend vendors or browser tests, not to serve the application.

## First connection

1. Register the first account and sign in.
2. Open **New Connection**, enter the host, port and SSH username.
3. Choose a password or an imported SSH key. Use a jump host if the target requires a bastion.
4. Optionally save a profile and select a post-connect action.
5. Connect. Persistence keeps the session in tmux on the remote host; if the host has no tmux, SSHDeck provides one when you connect (see [persistent sessions](workflows.md#persistent-sessions)).

Tailscale SSH has separate authorization and deployment requirements: follow the [Tailscale guide](tailscale-ssh.md) before enabling it.
