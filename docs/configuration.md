# Configuration

[Back to README](../README.md)

Run exactly one application worker. Redis stores rate-limit counters; it does not share SSH connections between workers.

Admin settings can override registration, capacity, timeout and rate-limit defaults at runtime. These overrides persist in `DATA_DIR/app_settings.json`; use Reset in Admin to return to environment defaults.


### Environment Variables

#### Core
| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SECRET_KEY` | No | auto | Root secret for signed cookies and SSH-key encryption. Docker generates and persists it; source installations must supply a stable value. Keep it across restarts and backups. |
| `DEBUG` | No | `False` | Enable debug mode (development only) |
| `DATA_DIR` | No | `./data` (source), `/app/data` (Docker) | Persistent data directory |

#### Server
| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `HOST` | No | `127.0.0.1` | Bind address (`0.0.0.0` in Docker) |
| `PORT` | No | `5000` | Listen port |
| `APPLICATION_ROOT` | No | - | URL subpath when deploying under a prefix (e.g. `/sshdeck`). See [Subfolder Deployment](#subfolder-deployment) |
| `TRUSTED_PROXIES` | No | `0` | Set `1` when behind a reverse proxy |

#### CORS & Security Headers
| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `CORS_ORIGINS` | No | `http://localhost:5000`, `http://127.0.0.1:5000` | Allowed origins for CORS (comma-separated) |
| `ALLOW_CORS_WILDCARD` | No | `false` | Set `true` to allow `*` as CORS origin (homelab use only) |
| `SESSION_COOKIE_SECURE` | No | Auto | Set `true`/`false` to explicitly control secure cookies (auto-enabled in production) |

#### Features
| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `REGISTRATION_ENABLED` | No | `True` | Initial self-registration state (can be toggled later in the Admin Panel) |
| `ADMIN_USERS` | No | - | Comma-separated usernames granted admin on startup (e.g. `alice,bob`) |
| `SESSION_TIMEOUT` | No | `1800` | Idle SSH session timeout in seconds (30 minutes) |
| `BLOCK_INTERNAL_SSH` | No | `false` | Block SSH connections to internal/loopback addresses (`true` or `false`) |
| `TMUX_ENABLED` | No | `false` | Show and allow persistent tmux sessions. The provided Compose file sets this to `true` |
| `TMUX_DEFAULT` | No | `false` | Select persistent tmux for new connections by default. The provided Compose file sets this to `true` |
| `TMUX_SESSION_PREFIX` | No | `sshdeck` | Prefix used for tmux session names created on remote hosts |
| `TAILSCALE_SSH_ENABLED` | No | `false` | Enable shared-identity Tailscale SSH for administrators and explicitly allowed users |
| `TAILSCALE_SSH_ALLOWED_SSHDECK_USERS` | No | - | Comma-separated non-admin SSHDeck usernames allowed to use Tailscale SSH |
| `TAILSCALE_SSH_ALLOWED_TARGETS` | No | - | Optional comma-separated exact host/IP allowlist for Tailscale SSH targets |
| `TAILSCALE_SSH_ALLOWED_REMOTE_USERS` | No | - | Optional comma-separated exact remote OS username allowlist for Tailscale SSH |
| `MAX_DOWNLOAD_SIZE` | No | `104857600` | Maximum file download size in bytes (100 MB) |
| `MAX_ZIP_DOWNLOAD_SIZE` | No | `524288000` | Maximum ZIP download size in bytes (500 MB) |
| `MAX_EDITOR_FILE_SIZE` | No | `5242880` | Maximum file size editable in the inline editor in bytes (5 MB) |
| `ADMIN_PANEL_ENABLED` | No | `True` | Serve the Admin Panel at all (`True` or `False`) |
| `MAX_SESSIONS` | No | `100` | SSH sessions the server will hold at once, across all users |
| `MAX_SESSIONS_PER_USER` | No | `50` | SSH sessions one account may hold at once |
| `MAX_VIEWS_PER_SESSION` | No | `8` | Browser tabs/devices that may attach to one session at the same time; each tmux view is its own client; plain shells share a PTY |
| `MAX_TRANSFER_MEMBERS` | No | `10000` | Files a single server-to-server transfer may carry |

#### Rate Limiting
| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `RATELIMIT_ENABLED` | No | `True` | Enable rate limiting (`True` or `False`) |
| `RATELIMIT_LOGIN_LIMIT` | No | `5 per minute` | Login rate limit (format: `N per {second\|minute\|hour}`) |
| `SSH_CONNECT_RATELIMIT` | No | `60 per minute` | Per-user limit on SSH connection attempts (`ssh_connect` / `quick_connect`; format: `N per {second\|minute\|hour}`) |
| `RATELIMIT_DEFAULT` | No | `200 per hour` | Default rate limit for endpoints (format: `N per {second\|minute\|hour}`) |
| `RATELIMIT_STORAGE_URL` | No | `memory://` | Rate-limit storage (`memory://`, `redis://`, or `rediss://`). Redis preserves counters across app restarts while the Redis service remains available; it does not remove the single-worker requirement. |

### Configuration via .env file

Instead of exporting every variable, you can place them in a `.env` file in the
project root. It is loaded automatically on startup. Copy the provided template
to get started:

```bash
cp .env.example .env
# edit .env and set at least SECRET_KEY
python start.py
```

Real environment variables (set via the shell, Docker, or systemd) always take
precedence over values in `.env`, so the file works safely alongside existing
deployments. `.env` is git-ignored — never commit your real secrets.

### Reverse Proxy Setup

#### Traefik

```yaml
labels:
  - "traefik.enable=true"
  - "traefik.http.routers.sshdeck.rule=Host(`ssh.example.com`)"
  - "traefik.http.routers.sshdeck.tls.certresolver=letsencrypt"
  - "traefik.http.services.sshdeck.loadbalancer.server.port=5000"
```

#### Nginx

```nginx
location / {
    proxy_pass http://sshdeck:5000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

#### Caddy

```caddyfile
ssh.example.com {
    reverse_proxy sshdeck:5000
}
```

### Subfolder Deployment

To serve the app under a URL subpath like `https://server.local/sshdeck`, set:

```bash
APPLICATION_ROOT=/sshdeck
TRUSTED_PROXIES=1
```

Then configure your reverse proxy to strip the prefix and forward it via `X-Forwarded-Prefix`.

#### Nginx (subfolder)

```nginx
location /sshdeck/ {
    proxy_pass http://sshdeck:5000/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Prefix /sshdeck;
}
```

#### Traefik (subfolder)

```yaml
labels:
  - "traefik.enable=true"
  - "traefik.http.routers.sshdeck.rule=Host(`server.local`) && PathPrefix(`/sshdeck`)"
  - "traefik.http.middlewares.sshdeck-strip.stripprefix.prefixes=/sshdeck"
  - "traefik.http.middlewares.sshdeck-prefix.headers.customrequestheaders.X-Forwarded-Prefix=/sshdeck"
  - "traefik.http.routers.sshdeck.middlewares=sshdeck-strip,sshdeck-prefix"
  - "traefik.http.services.sshdeck.loadbalancer.server.port=5000"
```

#### Caddy (subfolder)

```caddyfile
server.local {
    handle_path /sshdeck/* {
        reverse_proxy sshdeck:5000 {
            header_up X-Forwarded-Prefix /sshdeck
        }
    }
}
```

### Homelab Configuration

For homelab use where you access the service from various internal IPs:

```bash
CORS_ORIGINS=*
ALLOW_CORS_WILDCARD=true
TRUSTED_PROXIES=0
```

Set `TRUSTED_PROXIES=1` only behind one trusted reverse proxy.

> **Note:** Only use wildcard CORS in trusted network environments.

