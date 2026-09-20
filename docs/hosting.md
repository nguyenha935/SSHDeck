# Hosting and data protection

[Back to README](../README.md) · [Configuration and proxy examples](configuration.md)

## SSH compatibility


SSHDeck uses Paramiko 5 and supports imported RSA, Ed25519, and
ECDSA private keys. Modern RSA keys remain supported when the server negotiates
RSA/SHA-2 signatures. Passphrase-encrypted imported private keys are not
currently supported.

Paramiko 5 no longer supports DSA/DSS, RSA signatures using SHA-1
(`ssh-rsa` as a signature algorithm), SHA-1 key exchange, GSSAPI, or
group-exchange parameters below 2048 bits. Required SSH servers must offer
modern algorithms; SSHDeck does not re-enable the removed algorithms.
Existing DSA/DSS key files are not deleted or rewritten automatically and must
be replaced before upgrading.

Before deploying the upgrade, run the read-only compatibility check against a
copy of `DATA_DIR`, using the same `SECRET_KEY` that encrypted the stored
keys:

```bash
SECRET_KEY='the-current-deployment-secret' \
python scripts/check_paramiko5_readiness.py \
  --data-dir /absolute/path/to/copied-data
```

Exit code `0` means every discovered key is compatible. Exit code `2`
means rollout is blocked by an unsupported, encrypted, unreadable, or unsafe
key entry. Never point the check at the active writable data volume; it is
designed for a read-only snapshot and never migrates plaintext legacy keys.
Its report omits key content, configured key names, filenames, paths, and the
`SECRET_KEY`.

### Hosting & Data Protection

SSHDeck is the SSH/SFTP client: the browser connects to this server,
and this server opens the connection to the target host. For team use or a
hosted deployment, treat the SSHDeck host as trusted infrastructure.

#### Data processed by the server

While a connection is being established or is active, the server handles:

- **SSH credentials during connection setup.** Target and jump-host passwords,
  or the decrypted private key selected for authentication, are passed to
  Paramiko. Passwords are not written to profiles, the database, or audit logs,
  and credentials are not kept in the in-memory SSH session object. Local
  references are dropped after the connection attempt; Python does not provide
  a guarantee that secret bytes are securely zeroed from process memory.
- **Terminal data.** Keystrokes, remote output, broadcast input, and transcript
  data are relayed through the server.
- **SFTP data.** Uploads, downloads, previews, editor saves, and ZIP folder
  downloads pass through the server process.

The persistent data directory contains:

- The SQLite database with usernames, bcrypt password hashes, account flags,
  timestamps, browser-session metadata, and SSH-session metadata. SSH transport
  connections themselves remain in memory; the database record does not make a
  connection survive a server restart.
- Per-user JSON files for profiles, jump hosts, commands, notepad content, and
  settings. Saved profiles and jump-host definitions do not contain passwords.
- Encrypted SSH private keys and their metadata.
- Quarantined files from deleted accounts under
  `DATA_DIR/deleted_users/user_<id>_<uuid>`. Deleting an account revokes its
  live access and moves its active `users/user_<id>` directory atomically out
  of the active namespace; it does not securely erase the retained files.
- Persistent `known_hosts` fingerprints.
- Application and audit logs. Depending on the event, audit entries include
  usernames, source IPs, user agents, target hosts, filenames, sizes, and
  timestamps.

An administrator with access to the host or Python process can observe live
session content. Access to the data volume exposes account metadata, saved
configuration, logs, and — with the default Docker setup — the persisted
`SECRET_KEY`. Restrict access to the host, data volume, logs, and backups.

#### Security boundary

- SSH connection passwords are not intentionally persisted. SSHDeck
  login passwords are stored only as bcrypt hashes.
- The project contains no built-in telemetry and serves its frontend libraries
  from `static/vendor/` instead of runtime CDNs. Connections explicitly
  requested by users, such as SSH targets and DNS lookups, still leave the host.
- This is **not end-to-end encryption between the browser and target host**.
  TLS protects browser-to-server traffic when configured at the reverse proxy,
  and SSH protects server-to-target traffic, but the SSHDeck process
  necessarily handles terminal and file data in plaintext between those links.

#### SSH key protection

- Private keys are encrypted at rest with Fernet (AES-128-CBC with
  HMAC-SHA256 authentication).
- A per-user Fernet key is derived with PBKDF2-HMAC-SHA256 (600,000 iterations)
  from `SECRET_KEY` and the user id. One user's derived key therefore does not
  decrypt another user's key files.
- The keys directory is set to `0700`, and key files are written with `0600`
  permissions.
- Keys are decrypted when needed for authentication. Legacy plaintext key files
  are migrated to the encrypted format when first read.
- `SECRET_KEY` is the root of trust. Docker generates it on first start and
  stores it in `DATA_DIR/secret_key` unless supplied through the environment.
  Anyone with both the encrypted key files and this secret can decrypt the
  keys. For stronger separation, provide `SECRET_KEY` through an external
  secrets mechanism and protect backups of `DATA_DIR` accordingly.

#### Session protection

Browser sessions use Flask-Login cookies signed with `SECRET_KEY`. Session and
remember-me cookies are `HttpOnly`, `SameSite=Lax`, and secure by default outside
debug mode unless explicitly overridden with `SESSION_COOKIE_SECURE`. Remember-me
cookies last seven days. Logins without “Remember me” use browser-session
cookies; the application does not currently enforce a separate 30-minute HTTP
idle timeout. Forms are protected by Flask-WTF CSRF tokens. Login attempts are
rate-limited, unknown-user checks perform a dummy bcrypt verification, and new
or changed passwords are limited to 72 bytes when encoded as UTF-8 before they
are passed to bcrypt.

Locking or deleting an account immediately rejects further HTTP and WebSocket
authorization and revokes its tracked Socket.IO, SSH, and temporary SFTP
connections. An explicit logout performs the same live-connection cleanup.

Authenticated application WebSocket events use `socket_login_required`.
Session-scoped terminal and SFTP operations additionally verify ownership before
acting on a session, and terminal output is emitted to the owning user's private
room. SSH connection attempts are rate-limited per user. `SESSION_TIMEOUT`
(default: 1800 seconds) closes idle SSH sessions, with default capacity guards of 100 sessions globally, 50 per user and 8 views per session. Administrators can change these limits.

New host keys use a persistent trust-on-first-use policy: the fingerprint is
stored and logged. A changed key for a known host is rejected by Paramiko. The
optional `BLOCK_INTERNAL_SSH` guard additionally blocks loopback, link-local,
private, and reserved targets after DNS resolution.

#### Operator responsibilities

- Terminate TLS at a trusted reverse proxy and configure `CORS_ORIGINS`,
  `TRUSTED_PROXIES`, and secure cookies for the public hostname.
- Restrict and encrypt backups of `DATA_DIR`; they may contain logs, account
  metadata, encrypted private keys, and the Docker-generated `SECRET_KEY`.
- Define a retention and secure-disposal policy for `DATA_DIR/deleted_users`.
  Account deletion quarantines those files to prevent numeric user-id reuse
  from exposing them, but does not wipe them automatically.
- Configure log rotation and a retention policy. The application writes log
  files but does not rotate them itself.
- Keep the service single-worker while SSH state remains in memory. Running
  multiple workers does not share live SSH sessions.

