from flask_sqlalchemy import SQLAlchemy
from flask_login import UserMixin
from datetime import datetime, timezone
import bcrypt
from pathlib import Path

db = SQLAlchemy()

class User(db.Model, UserMixin):
    """User model for authentication."""
    __tablename__ = 'users'

    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(80), unique=True, nullable=False, index=True)
    password_hash = db.Column(db.String(128), nullable=False)
    created_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))
    last_login = db.Column(db.DateTime)
    is_admin = db.Column(db.Boolean, nullable=False, default=False)
    is_locked = db.Column(db.Boolean, nullable=False, default=False)

    socket_sessions = db.relationship('SocketSession', backref='user', cascade='all, delete-orphan', lazy='dynamic')
    ssh_sessions = db.relationship('SSHSession', backref='user', cascade='all, delete-orphan', lazy='dynamic')

    def set_password(self, password):
        """Hash and set user password using bcrypt."""
        self.password_hash = bcrypt.hashpw(password.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')

    def check_password(self, password):
        """Verify password against stored hash."""
        return bcrypt.checkpw(password.encode('utf-8'), self.password_hash.encode('utf-8'))

    def get_data_dir(self):
        """Get user-specific data directory."""
        import config
        user_dir = config.DATA_DIR / 'users' / f"user_{self.id}"
        user_dir.mkdir(parents=True, exist_ok=True)
        return user_dir

    def __repr__(self):
        return f'<User {self.username}>'


def ensure_user_columns():
    """Additive, idempotent schema migration for the users table.

    db.create_all() only creates missing TABLES, never missing COLUMNS, so new
    columns (is_admin, is_locked) added above would be absent on an existing
    production database. This adds them in place via ALTER TABLE without touching
    existing rows. Must run inside an app context, after db.create_all().
    """
    from sqlalchemy import text, inspect
    inspector = inspect(db.engine)
    if 'users' not in inspector.get_table_names():
        return  # fresh DB: create_all() already made the table with all columns
    existing = {c['name'] for c in inspector.get_columns('users')}
    added_is_admin = 'is_admin' not in existing
    additions = []
    if added_is_admin:
        additions.append("ALTER TABLE users ADD COLUMN is_admin BOOLEAN NOT NULL DEFAULT 0")
    if 'is_locked' not in existing:
        additions.append("ALTER TABLE users ADD COLUMN is_locked BOOLEAN NOT NULL DEFAULT 0")
    for stmt in additions:
        db.session.execute(text(stmt))
    # First-time migration of an existing install: there was no role separation
    # before. Grant admin ONLY to the oldest account (lowest id) instead of every
    # user, so upgrading a multi-user install does not silently make everyone an
    # admin. Runs once — on later starts the column already exists, so this block
    # is skipped. (New installs seed their first admin via auth bootstrap.)
    if added_is_admin:
        result = db.session.execute(text(
            "UPDATE users SET is_admin = 1 "
            "WHERE id = (SELECT id FROM users ORDER BY id LIMIT 1)"
        ))
        try:
            from .audit_logger import log_info
            log_info("Schema migration: granted admin to the oldest pre-existing user",
                     count=getattr(result, 'rowcount', None))
        except Exception:
            pass
    if additions:
        db.session.commit()

class SocketSession(db.Model):
    """Tracks SocketIO sessions for users (browser connections)."""
    __tablename__ = 'socket_sessions'

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('users.id'), nullable=False, index=True)
    socket_sid = db.Column(db.String(128), unique=True, nullable=False, index=True)
    created_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))
    last_activity = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))
    user_agent = db.Column(db.String(256))
    # S2 rev6: which worker process/boot owns this row. Nullable and additive so
    # the upgrade cannot fail and pre-upgrade rows simply read NULL -- and NULL
    # is meaningful: a row that predates this column cannot belong to the
    # current boot, so startup reconciliation treats it as stale. Never used to
    # blanket-clear: only rows whose boot id is stale or NULL are removed, and
    # only while the single-worker guard is held (see app/worker_guard.py).
    worker_boot_id = db.Column(db.String(36), nullable=True, index=True)

    def __repr__(self):
        return f'<SocketSession user_id={self.user_id} sid={self.socket_sid[:8]}...>'


class WorkerClaim(db.Model):
    """The single-worker guard's claim row (S2 rev6).

    The SSH session registry is a process-local module global
    (ssh_manager.sessions), and the capacity cap counts len(sessions) in that
    same process. Two workers would therefore each see a fraction of reality:
    the cap, the idle reaper and revoke would all operate on partial state, and
    a booting worker clearing socket rows would delete a live worker's rows.

    This table makes that implicit `-w 1` dependence explicit and
    self-enforcing. Exactly one row (id=1) exists; whoever holds it may serve
    and may reconcile socket rows. Liveness is evidence-carrying (pid + boot id
    + a heartbeat the holder refreshes) so a crashed holder can be taken over
    rather than locking the app out of its own startup.

    Multi-worker support is explicitly OUT OF SCOPE: it requires a shared
    out-of-process session registry, not a bigger lock.
    """
    __tablename__ = 'worker_claims'

    id = db.Column(db.Integer, primary_key=True)
    boot_id = db.Column(db.String(36), nullable=False)
    pid = db.Column(db.Integer, nullable=False)
    # S2 rev7 (R2): the kernel start time of the claiming process (field 22 of
    # /proc/<pid>/stat). A pid alone cannot tell "the holder is still running"
    # from "this pid number was reused after a restart" -- container pids are
    # namespace-local and low. (pid, starttime) CAN, so it is what turns a fast
    # crash-restart from a 300-second lockout into an immediate takeover.
    # Nullable and additive: pre-upgrade rows and /proc-less platforms read NULL
    # and fall back to heartbeat staleness.
    pid_starttime = db.Column(db.BigInteger, nullable=True)
    hostname = db.Column(db.String(256), nullable=True)
    claimed_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))
    heartbeat_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))

    def __repr__(self):
        return f'<WorkerClaim pid={self.pid} boot={self.boot_id[:8]}...>'

class SSHSession(db.Model):
    """Tracks SSH connections for users (persistent across browser reconnects)."""
    __tablename__ = 'ssh_sessions'

    id = db.Column(db.Integer, primary_key=True)
    session_id = db.Column(db.String(36), unique=True, nullable=False, index=True)
    user_id = db.Column(db.Integer, db.ForeignKey('users.id'), nullable=False, index=True)
    host = db.Column(db.String(256), nullable=False)
    port = db.Column(db.Integer, nullable=False)
    username = db.Column(db.String(128), nullable=False)
    connected = db.Column(db.Boolean, default=True, index=True)
    created_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))
    last_activity = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))
    # Persistent tmux session support
    is_persistent = db.Column(db.Boolean, default=False, index=True)
    key_id = db.Column(db.String(64), nullable=True)
    auth_type = db.Column(db.String(16), nullable=False, default='password')
    tmux_session_name = db.Column(db.String(256), nullable=True)
    display_name = db.Column(db.String(128), nullable=True)
    # W1 SessionSnapshot v1: pane placement survives reload, and every restore
    # knows which contract version produced it. Both additive and nullable /
    # defaulted, so the previous image reads this table unchanged (the old
    # rollback container is backward-compatible with the migrated schema).
    pane_index = db.Column(db.Integer, nullable=True)
    snapshot_version = db.Column(db.Integer, nullable=False, default=1)

    def __repr__(self):
        return f'<SSHSession id={self.session_id[:8]}... {self.username}@{self.host}:{self.port}>'


def ensure_socket_session_columns():
    """Additive schema migration for the S2 worker/boot identity column.

    Same shape as ensure_ssh_session_columns below: additive only, never a drop,
    retype or destructive backfill, so the previous image reads this table
    unchanged and a rollback stays safe. worker_boot_id is nullable with no
    default, so existing rows become NULL -- which reconciliation reads as
    "cannot belong to this boot", the correct answer for a pre-upgrade row.
    """
    from sqlalchemy import text, inspect
    inspector = inspect(db.engine)
    if 'socket_sessions' not in inspector.get_table_names():
        return
    existing = {c['name'] for c in inspector.get_columns('socket_sessions')}
    additions = []
    if 'worker_boot_id' not in existing:
        additions.append(
            "ALTER TABLE socket_sessions ADD COLUMN worker_boot_id VARCHAR(36)")
    for stmt in additions:
        db.session.execute(text(stmt))
    if additions:
        db.session.commit()


def ensure_worker_claim_columns():
    """Additive schema migration for the S2 rev7 claim identity column.

    db.create_all() creates worker_claims fresh on first boot (with
    pid_starttime), but a database created by an EARLIER rev6 image has the
    table WITHOUT this column -- create_all does not alter existing tables.
    Additive and nullable, matching the repo's existing migration pattern:
    pre-upgrade rows read NULL and fall back to heartbeat staleness.
    """
    from sqlalchemy import text, inspect
    inspector = inspect(db.engine)
    if 'worker_claims' not in inspector.get_table_names():
        return
    existing = {c['name'] for c in inspector.get_columns('worker_claims')}
    additions = []
    if 'pid_starttime' not in existing:
        additions.append(
            "ALTER TABLE worker_claims ADD COLUMN pid_starttime BIGINT")
    for stmt in additions:
        db.session.execute(text(stmt))
    if additions:
        db.session.commit()


def ensure_ssh_session_columns():
    """Additive schema migration for persistent SSH session columns."""
    from sqlalchemy import text, inspect
    inspector = inspect(db.engine)
    if 'ssh_sessions' not in inspector.get_table_names():
        return
    existing = {c['name'] for c in inspector.get_columns('ssh_sessions')}
    additions = []
    if 'is_persistent' not in existing:
        additions.append("ALTER TABLE ssh_sessions ADD COLUMN is_persistent BOOLEAN NOT NULL DEFAULT 0")
    if 'key_id' not in existing:
        additions.append("ALTER TABLE ssh_sessions ADD COLUMN key_id VARCHAR(64)")
    added_auth_type = 'auth_type' not in existing
    if added_auth_type:
        additions.append(
            "ALTER TABLE ssh_sessions ADD COLUMN auth_type VARCHAR(16) "
            "NOT NULL DEFAULT 'password'"
        )
    if 'tmux_session_name' not in existing:
        additions.append("ALTER TABLE ssh_sessions ADD COLUMN tmux_session_name VARCHAR(256)")
    if 'display_name' not in existing:
        additions.append("ALTER TABLE ssh_sessions ADD COLUMN display_name VARCHAR(128)")
    # W1 SessionSnapshot v1 columns. Additive only: never a drop, retype or
    # destructive backfill, so restoring the previous image stays safe.
    if 'pane_index' not in existing:
        additions.append("ALTER TABLE ssh_sessions ADD COLUMN pane_index INTEGER")
    if 'snapshot_version' not in existing:
        additions.append("ALTER TABLE ssh_sessions ADD COLUMN snapshot_version INTEGER NOT NULL DEFAULT 1")
    for stmt in additions:
        db.session.execute(text(stmt))
    if added_auth_type:
        db.session.execute(text(
            "UPDATE ssh_sessions SET auth_type = 'key' WHERE key_id IS NOT NULL"
        ))
    if additions:
        db.session.commit()
