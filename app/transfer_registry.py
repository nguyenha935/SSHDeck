"""Owner-bound lifecycle records for server-to-server SFTP transfers.

Ported from upstream/main e47d48f `app/transfer_manager.py`, reduced to what
this build can actually support and no further.

WHY A REDUCTION. Upstream's TransferManager also issues one-use HTTP tokens and
reserves `QuotaKind.TRANSFER` slots through `app/quota_manager.py`, and its
socket handler runs each transfer through `app/runtime_lifecycle.py`.
Neither module exists in this build, and adding a quota subsystem
plus a runtime-lifecycle extension is a different change from fixing file
transfer. What is preserved here is every property the transfer protocol itself
depends on:

  * the SERVER creates the transfer id. Clients never invent one, so a client
    cannot name (and therefore cannot cancel, spoof or collide with) a transfer
    that is not its own.
  * ids are generated with `secrets.token_urlsafe` under the registry lock and
    re-drawn on collision, so two concurrent creates cannot share an id.
  * every record is keyed by (user_id, transfer_id). A different user presenting
    a valid id of someone else's transfer is indistinguishable from presenting a
    nonexistent one, and cannot overwrite or orphan the entry.
  * state is MONOTONIC. `terminalize` moves PENDING/RUNNING to exactly one
    terminal state and returns True only for the transition that actually won;
    every later attempt returns False. That single boolean is what makes the
    cancel-vs-complete race safe on both sides of the wire.
  * a per-user ceiling on concurrent transfers stands in for upstream's quota
    reservation ("as applicable"), so one account cannot start unbounded
    background copies.
  * terminal records are dropped, so the registry cannot grow without bound.

Upstream's `bind_runtime`/`close_and_cancel` generation fencing is deliberately
omitted: it exists to drain jobs across an app-runtime restart, which requires
the lifecycle extension this build does not have.

FIVE INVARIANTS THAT ARE NOT OBVIOUS FROM THE METHOD NAMES. Each one is here
because the straightforward version of this class gets it wrong:

  1. THE CONCURRENCY SLOT IS NOT THE RECORD STATE. A slot is taken at create and
     released only when the worker's `finally` has actually run, via
     `release_worker_slot`. Counting *records* instead would let a client cancel
     five transfers and immediately start five more while the five cancelled
     worker threads are still unwinding their SFTP closes, so the real number of
     live threads would be unbounded. Cancelling frees the record, never a slot.
  2. IDS ARE GLOBALLY UNIQUE, not merely unique within one user's namespace.
     Records are keyed by (user_id, transfer_id) for ownership, but ids are also
     tracked in `_id_owners` and redrawn against it: two users sharing an id
     would make client-side logs, progress rows and cancel acks ambiguous even
     though the registry itself could tell them apart.
  6. SLOT RELEASE IS OWNER-CHECKED, and `owner_sid` is normalized like every
     other id. `_id_owners` maps id -> owning user precisely so one user cannot
     release another's slot, and a blank/bool owner_sid cannot masquerade as a
     tracked socket.
  3. THE WORKER HOLDS THE EVENT OBJECT, NOT THE ID. `cancel` drops the record, so
     `is_cancelled(...)` answers False for a cancelled transfer once it is gone.
     A worker that polled by id would therefore never see its own cancellation.
     It must capture `record.cancel_event` before starting and poll that.
  4. CANCEL CAN WIN WHILE THE TRANSFER IS STILL PENDING. The worker must treat
     `mark_running()` returning False as "already terminalized" and return
     without opening any SFTP connection; otherwise a cancel that lands in the
     gap between create and thread start is silently ignored.
  5. DISCONNECT IS SCOPED TO A SOCKET, NOT A USER. Records remember the
     `owner_sid` that created them so one browser tab closing cannot cancel a
     transfer another tab of the same user is still watching.
     `cancel_all_for_socket` is the handler-facing call; `cancel_all_for_user`
     remains for a verified last-socket disconnect and for logout.
  7. EXPLICIT CANCEL IS OWNER-SOCKET-CHECKED, not merely user-checked. Invariant 5
     already scoped the DISCONNECT sweep to a socket, but an explicit
     `cancel_transfer` authorized on user_id alone contradicted it: a second tab
     of the same account that learned a transfer_id could stop a copy it never
     started, and the tab that did start it was never told. `cancel_for_owner`
     is the authorization boundary for that path -- it requires the requesting
     sid to equal the record's `owner_sid`, and it returns the SAME False for a
     nonexistent id, another user's id, and a same-user non-owner tab, so the ack
     cannot be used to probe for transfers the caller does not own.

     LEGACY FALLBACK, deliberately narrow: a record whose `owner_sid` is None was
     created before a sid could be captured. Such a record has no owner to
     compare against, so it falls back to the user-ownership check of invariant 5
     -- and ONLY such a record. A record that HAS an owner_sid is never
     cancellable by a different sid, so the fallback cannot widen authority for
     any owner-bound transfer.
"""

import secrets
import threading
from enum import Enum


class TransferState(Enum):
    PENDING = 'pending'
    RUNNING = 'running'
    CANCELLED = 'cancelled'
    FAILED = 'failed'
    COMPLETED = 'completed'


TERMINAL_STATES = frozenset({
    TransferState.CANCELLED,
    TransferState.FAILED,
    TransferState.COMPLETED,
})

ACTIVE_STATES = frozenset({TransferState.PENDING, TransferState.RUNNING})

DIRECTIONS = frozenset({'server_to_server'})


class TransferLimitExceeded(RuntimeError):
    """This user already holds the maximum number of concurrent transfers."""


def _normalize_id(value, name):
    """Upstream's identity normalizer: reject None/bool, coerce str/int, strip.

    `bool` is rejected explicitly because it is an `int` subclass in Python, so
    `create(user_id=True, ...)` would otherwise register under the id '1'.
    """
    if (
        value is None
        or isinstance(value, bool)
        or not isinstance(value, (str, int))
    ):
        raise ValueError(f'{name} is required')
    normalized = str(value).strip()
    if not normalized:
        raise ValueError(f'{name} is required')
    return normalized


class TransferRecord:
    """A transfer whose identity binding cannot be reassigned after creation."""

    __slots__ = ('_transfer_id', '_user_id', '_source_session_id',
                 '_dest_session_id', '_direction', '_metadata', '_state',
                 '_cancel_event', '_owner_sid')

    def __init__(self, transfer_id, user_id, source_session_id,
                 dest_session_id, direction, metadata, owner_sid=None):
        self._transfer_id = transfer_id
        self._user_id = user_id
        self._source_session_id = source_session_id
        self._dest_session_id = dest_session_id
        self._direction = direction
        self._metadata = dict(metadata)
        self._state = TransferState.PENDING
        self._cancel_event = threading.Event()
        # The socket that started this transfer. Disconnect cancellation is
        # scoped to it so a second tab of the same user is unaffected.
        self._owner_sid = owner_sid

    @property
    def transfer_id(self):
        return self._transfer_id

    @property
    def user_id(self):
        return self._user_id

    @property
    def source_session_id(self):
        return self._source_session_id

    @property
    def dest_session_id(self):
        return self._dest_session_id

    @property
    def direction(self):
        return self._direction

    @property
    def metadata(self):
        return dict(self._metadata)

    @property
    def state(self):
        return self._state

    @property
    def cancel_event(self):
        """The event object a worker must capture and poll.

        Workers hold this rather than calling ``is_cancelled(transfer_id)``: the
        record is dropped the moment a cancel wins, so an id-based poll would
        stop reporting the cancellation it is looking for.
        """
        return self._cancel_event

    @property
    def owner_sid(self):
        return self._owner_sid

    def __repr__(self):
        return (f'TransferRecord(transfer_id={self._transfer_id!r}, '
                f'state={self._state.value!r})')


class TransferRegistry:
    """Own server-issued transfer ids, ownership and monotonic state."""

    # Concurrent background workers allowed per user. Stands in for upstream's
    # QuotaKind.BACKGROUND_JOB reservation, which needs a quota subsystem this
    # build does not have.
    DEFAULT_MAX_ACTIVE_PER_USER = 5

    def __init__(self, max_active_per_user=DEFAULT_MAX_ACTIVE_PER_USER):
        if (isinstance(max_active_per_user, bool)
                or not isinstance(max_active_per_user, int)
                or max_active_per_user < 1):
            raise ValueError('max_active_per_user must be a positive integer')
        self._max_active_per_user = max_active_per_user
        self._lock = threading.Lock()
        # (user_id, transfer_id) -> TransferRecord. Keying by the PAIR is what
        # makes cross-user access structurally impossible rather than merely
        # checked: another user's lookup builds a different key.
        self._records = {}
        # user_id -> outstanding worker slots. Independent of _records: a slot
        # survives cancellation and is returned only by release_worker_slot from
        # the worker's finally block (invariant 1 in the module docstring).
        self._worker_slots = {}
        # transfer_id -> owning user_id, for every id currently in use by ANY
        # user. Serves two purposes: generated ids are globally unique rather
        # than unique per user (invariant 2), and slot release is OWNER-CHECKED
        # (invariant 6) -- a bare membership set let any user release an id they
        # merely knew, freeing another user's slot while that user's worker was
        # still running and leaking the victim's slot when their own finally ran.
        self._id_owners = {}

    def create(self, user_id, source_session_id, dest_session_id, metadata=None,
               direction='server_to_server', owner_sid=None):
        """Register a new transfer under a freshly generated server id.

        Takes a worker slot as well as creating the record. The caller MUST
        release it with ``release_worker_slot`` from the worker's finally block,
        including when the worker never starts (thread-spawn failure) or the
        transfer is cancelled before it runs.
        """
        user_id = _normalize_id(user_id, 'user_id')
        source_session_id = _normalize_id(source_session_id,
                                         'source_session_id')
        dest_session_id = _normalize_id(dest_session_id, 'dest_session_id')
        if direction not in DIRECTIONS:
            raise ValueError('direction is invalid')
        # owner_sid goes through the SAME normalization as every other id, so a
        # blank string, a bool or an object cannot be stored as a socket
        # identity. It was previously accepted verbatim, which meant `False` or
        # '   ' became an owner_sid that cancel_all_for_socket could never match
        # while still looking like a tracked socket. None stays allowed and means
        # "no socket recorded", which cancel_all_for_socket refuses to match.
        if owner_sid is not None:
            owner_sid = _normalize_id(owner_sid, 'owner_sid')

        with self._lock:
            # Counts SLOTS, not active records: five cancelled-but-unwound
            # workers still occupy five slots, so a start/cancel loop cannot
            # spawn threads without limit.
            if self._worker_slots.get(user_id, 0) >= self._max_active_per_user:
                raise TransferLimitExceeded(
                    'too many concurrent transfers for this user')
            transfer_id = self._unique_transfer_id_locked()
            record = TransferRecord(
                transfer_id=transfer_id,
                user_id=user_id,
                source_session_id=source_session_id,
                dest_session_id=dest_session_id,
                direction=direction,
                metadata=metadata or {},
                owner_sid=owner_sid,
            )
            self._records[(user_id, transfer_id)] = record
            self._id_owners[transfer_id] = user_id
            self._worker_slots[user_id] = (
                self._worker_slots.get(user_id, 0) + 1)
            return record

    def release_worker_slot(self, transfer_id, user_id):
        """Return one worker slot. Call ONLY from the worker's finally block.

        OWNER-CHECKED: the id must be one THIS user reserved. A bare membership
        test let any caller release any id it knew, which is worse than it
        sounds -- releasing Bob's id decremented ALICE's slot count (freeing a
        slot she never held) and dropped the id, so when Bob's own worker finally
        ran it found the id gone and returned False, leaking Bob's slot for the
        lifetime of the process.

        Idempotent per transfer id: the slot is tied to the id that reserved it,
        so a double release (worker finally plus an error path) cannot hand back
        a slot another transfer is holding. Returns True when this call actually
        released the slot.
        """
        try:
            transfer_id = _normalize_id(transfer_id, 'transfer_id')
            user_id = _normalize_id(user_id, 'user_id')
        except ValueError:
            return False
        with self._lock:
            if self._id_owners.get(transfer_id) != user_id:
                return False
            del self._id_owners[transfer_id]
            outstanding = self._worker_slots.get(user_id, 0)
            if outstanding <= 1:
                self._worker_slots.pop(user_id, None)
            else:
                self._worker_slots[user_id] = outstanding - 1
            return True

    def worker_slots(self, user_id):
        """Outstanding worker slots for one user (diagnostics and tests)."""
        try:
            user_id = _normalize_id(user_id, 'user_id')
        except ValueError:
            return 0
        with self._lock:
            return self._worker_slots.get(user_id, 0)

    def mark_running(self, transfer_id, user_id):
        """PENDING -> RUNNING. False if it is not this user's pending transfer."""
        return self._transition(transfer_id, user_id,
                                allowed={TransferState.PENDING},
                                target=TransferState.RUNNING,
                                terminal=False)

    def cancel(self, transfer_id, user_id):
        """Set the cancel event and terminalize, iff this user owns an active one.

        Returns True only for the call that actually cancelled. A nonexistent
        id, another user's id, and an already-terminal transfer all return
        False, so the ack cannot be used to probe for other users' transfers.

        NOT the entry point for a client's `cancel_transfer` request: that path is
        socket-scoped and must use ``cancel_for_owner`` (invariant 7). This
        user-scoped form remains for callers that legitimately have no socket to
        check against -- server-side lifecycle cancellation and logout -- and is
        the primitive the socket-scoped form is defined against.
        """
        return self._transition(transfer_id, user_id,
                                allowed=ACTIVE_STATES,
                                target=TransferState.CANCELLED,
                                terminal=True)

    def cancel_for_owner(self, transfer_id, user_id, owner_sid):
        """Cancel iff the REQUESTING SOCKET owns the transfer (invariant 7).

        Returns (cancelled, owner_sid): the boolean is True only for the call that
        actually cancelled, and owner_sid is the sid the terminal event must be
        delivered to -- captured here, under the lock, because ``cancel`` drops the
        record and the caller could not read it afterwards.

        Every refusal returns (False, None) and is indistinguishable: a
        nonexistent id, another user's id, an already-terminal transfer, and a
        same-user tab that is not the owner all look identical to the caller.

        A record with NO owner_sid (legacy, created before a sid was captured)
        falls back to user-ownership only. A record that HAS an owner_sid is
        cancellable by that sid alone, so the fallback never widens authority.
        """
        try:
            transfer_id = _normalize_id(transfer_id, 'transfer_id')
            user_id = _normalize_id(user_id, 'user_id')
        except ValueError:
            return False, None
        # A blank / bool / non-scalar sid is not an identity and must not be able
        # to match anything, including a legacy record's None.
        try:
            requester_sid = _normalize_id(owner_sid, 'owner_sid')
        except ValueError:
            requester_sid = None

        with self._lock:
            record = self._records.get((user_id, transfer_id))
            if record is None or record._state not in ACTIVE_STATES:
                return False, None

            record_sid = record._owner_sid
            if record_sid is not None:
                # Owner-bound: only the socket that created it may cancel it.
                if requester_sid is None or requester_sid != record_sid:
                    return False, None
            # else: legacy record with no recorded owner -> user check already
            # passed by finding the record under (user_id, transfer_id).

            record._state = TransferState.CANCELLED
            record._cancel_event.set()
            self._records.pop((user_id, transfer_id), None)
            return True, record_sid

    def complete(self, transfer_id, user_id):
        """RUNNING -> COMPLETED. False if a cancel already won the race."""
        return self._transition(transfer_id, user_id,
                                allowed={TransferState.RUNNING},
                                target=TransferState.COMPLETED,
                                terminal=True)

    def fail(self, transfer_id, user_id):
        """Active -> FAILED. False if the transfer already terminalized."""
        return self._transition(transfer_id, user_id,
                                allowed=ACTIVE_STATES,
                                target=TransferState.FAILED,
                                terminal=True)

    def is_cancelled(self, transfer_id, user_id):
        """True only while a record for this pair still exists AND is cancelled.

        NOT usable by a worker to detect its own cancellation: `cancel` drops the
        record, so this returns False for a transfer that was in fact cancelled.
        Workers must poll the `record.cancel_event` object they captured before
        starting (invariant 3 in the module docstring). This method exists for
        callers that legitimately ask about a still-registered transfer.
        """
        try:
            user_id = _normalize_id(user_id, 'user_id')
            transfer_id = _normalize_id(transfer_id, 'transfer_id')
        except ValueError:
            return False
        with self._lock:
            record = self._records.get((user_id, transfer_id))
            return bool(record and record._cancel_event.is_set())

    def get(self, transfer_id, user_id):
        """This user's record, or None. Never another user's."""
        try:
            user_id = _normalize_id(user_id, 'user_id')
            transfer_id = _normalize_id(transfer_id, 'transfer_id')
        except ValueError:
            return None
        with self._lock:
            return self._records.get((user_id, transfer_id))

    def active_count(self, user_id):
        """Live (non-terminal) records for one user.

        Distinct from ``worker_slots``: cancelling drops the record immediately
        while its worker thread is still unwinding, so this can read 0 while
        slots remain held. The concurrency ceiling is enforced on slots.
        """
        try:
            user_id = _normalize_id(user_id, 'user_id')
        except ValueError:
            return 0
        with self._lock:
            return sum(1 for (owner, _tid), record in self._records.items()
                       if owner == user_id and record._state in ACTIVE_STATES)

    def cancel_all_for_socket(self, user_id, owner_sid):
        """Cancel this user's active transfers that belong to ONE socket.

        The handler-facing disconnect call. A user with two tabs open has two
        sids; closing one must not stop a transfer the other tab started and is
        still showing progress for. A record with no owner_sid is never matched
        here, so an untracked transfer is left alone rather than cancelled by a
        coincidence of falsy values.
        """
        try:
            user_id = _normalize_id(user_id, 'user_id')
        except ValueError:
            return 0
        # Normalized with the same rules create applies, so a sid that arrives
        # with surrounding whitespace still matches the record it stored, and a
        # blank/bool/invalid sid matches nothing instead of raising.
        try:
            owner_sid = _normalize_id(owner_sid, 'owner_sid')
        except ValueError:
            return 0
        with self._lock:
            return self._cancel_records_locked(
                lambda record: (record._user_id == user_id
                                and record._owner_sid == owner_sid))

    def cancel_all_for_user(self, user_id):
        """Cancel every active transfer for one user, across all their sockets.

        NOT for ordinary disconnects — see ``cancel_all_for_socket``. This is for
        a verified last-socket disconnect or an account-level teardown (logout,
        lockout), where no tab remains that could still own a transfer.
        """
        try:
            user_id = _normalize_id(user_id, 'user_id')
        except ValueError:
            return 0
        with self._lock:
            return self._cancel_records_locked(
                lambda record: record._user_id == user_id)

    def _cancel_records_locked(self, predicate):
        """Terminalize every active record matching predicate. Caller holds lock.

        Slots are deliberately NOT released here: the workers are still unwinding
        and release them from their own finally blocks.
        """
        records = [record for record in self._records.values()
                   if record._state in ACTIVE_STATES and predicate(record)]
        for record in records:
            record._state = TransferState.CANCELLED
            record._cancel_event.set()
            self._records.pop((record._user_id, record._transfer_id), None)
        return len(records)

    def _transition(self, transfer_id, user_id, allowed, target, terminal):
        try:
            transfer_id = _normalize_id(transfer_id, 'transfer_id')
            user_id = _normalize_id(user_id, 'user_id')
        except ValueError:
            return False

        with self._lock:
            record = self._records.get((user_id, transfer_id))
            if record is None or record._state not in allowed:
                return False
            record._state = target
            if target is TransferState.CANCELLED:
                record._cancel_event.set()
            if terminal:
                # Dropped on the winning terminal transition, which is also what
                # makes every later transition return False.
                self._records.pop((user_id, transfer_id), None)
            return True

    def _unique_transfer_id_locked(self):
        """Draw an id unused by ANY user, redrawing on collision.

        Checked against `_id_owners` rather than `_records`, so an id still held
        by a live worker slot cannot be reissued even after its record was
        dropped by a terminal transition.
        """
        while True:
            transfer_id = secrets.token_urlsafe(18)
            if transfer_id not in self._id_owners:
                return transfer_id


# Process-wide registry used by the socket handlers.
transfer_registry = TransferRegistry()
