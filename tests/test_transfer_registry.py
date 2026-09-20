"""Server-issued transfer identity, ownership, slots and terminal races.

app/transfer_registry.py replaced a plain `{transfer_id: cancel_event}` dict. The
dict version let a client invent its own ids, could not tell a cancel from a
completion, and freed its concurrency accounting the instant a cancel arrived.
Each test below pins one property that the dict version got wrong, so a
regression to "simpler" bookkeeping fails here rather than in production.

The five invariants named in the module docstring of transfer_registry.py are
covered by TestWorkerSlots (1), TestGlobalIdUniqueness (2),
TestWorkerMustHoldTheEventObject (3), TestPendingCancelBarrier (4) and
TestDisconnectScope (5).
"""

import threading

import pytest

from app.transfer_registry import (
    TransferLimitExceeded,
    TransferRegistry,
    TransferState,
)


@pytest.fixture
def registry():
    return TransferRegistry()


def _create(registry, user_id='7', **kwargs):
    kwargs.setdefault('source_session_id', 'src')
    kwargs.setdefault('dest_session_id', 'dst')
    return registry.create(user_id=user_id, **kwargs)


class TestServerIssuedIdentity:
    """Clients never name a transfer, so they cannot collide with or spoof one."""

    def test_create_generates_the_id(self, registry):
        record = _create(registry)
        assert isinstance(record.transfer_id, str)
        assert len(record.transfer_id) >= 20
        assert record.state is TransferState.PENDING

    def test_create_accepts_no_caller_supplied_id(self, registry):
        with pytest.raises(TypeError):
            registry.create(user_id='7', source_session_id='src',
                            dest_session_id='dst', transfer_id='client-chosen')

    def test_two_creates_never_share_an_id(self, registry):
        ids = {_create(registry, user_id=str(i)).transfer_id for i in range(20)}
        assert len(ids) == 20

    def test_identity_fields_cannot_be_reassigned(self, registry):
        record = _create(registry)
        for attribute in ('transfer_id', 'user_id', 'source_session_id',
                          'dest_session_id', 'direction'):
            with pytest.raises(AttributeError):
                setattr(record, attribute, 'tampered')

    def test_metadata_is_copied_not_shared(self, registry):
        supplied = {'source_path': '/a'}
        record = _create(registry, metadata=supplied)
        supplied['source_path'] = '/mutated'
        assert record.metadata['source_path'] == '/a'
        record.metadata['source_path'] = '/also-mutated'
        assert record.metadata['source_path'] == '/a'

    @pytest.mark.parametrize('bad', [None, '', '   ', True, False, 1.5, object()])
    def test_unusable_user_ids_are_rejected(self, registry, bad):
        with pytest.raises(ValueError):
            _create(registry, user_id=bad)

    def test_string_and_int_user_ids_are_the_same_owner(self, registry):
        record = _create(registry, user_id=9)
        assert registry.get(record.transfer_id, '9') is record
        assert registry.get(record.transfer_id, 9) is record

    def test_an_invalid_direction_is_refused(self, registry):
        with pytest.raises(ValueError):
            _create(registry, direction='browser_upload')


class TestGlobalIdUniqueness:
    """Invariant 2: ids are unique across users, not just within one user."""

    def test_a_colliding_draw_is_redrawn_even_for_a_different_user(
            self, registry, monkeypatch):
        first = _create(registry, user_id='alice')

        # Force the next draw to repeat alice's id once, then produce a new one.
        draws = iter([first.transfer_id, 'fresh-unique-id'])
        monkeypatch.setattr('app.transfer_registry.secrets.token_urlsafe',
                            lambda _n: next(draws))

        second = _create(registry, user_id='bob')
        # Keyed by (user, id) the collision would have been "safe" yet would make
        # every client-visible id ambiguous between two accounts.
        assert second.transfer_id == 'fresh-unique-id'
        assert second.transfer_id != first.transfer_id

    def test_an_id_is_not_reissued_while_its_worker_slot_is_held(
            self, registry, monkeypatch):
        """A completed record is dropped, but its id is live until the slot frees."""
        record = _create(registry, user_id='alice')
        registry.mark_running(record.transfer_id, 'alice')
        assert registry.complete(record.transfer_id, 'alice') is True
        assert registry.get(record.transfer_id, 'alice') is None

        draws = iter([record.transfer_id, 'after-slot-id'])
        monkeypatch.setattr('app.transfer_registry.secrets.token_urlsafe',
                            lambda _n: next(draws))
        reused = _create(registry, user_id='bob')
        assert reused.transfer_id == 'after-slot-id'

    def test_an_id_becomes_available_again_after_release(self, registry,
                                                        monkeypatch):
        record = _create(registry, user_id='alice')
        registry.mark_running(record.transfer_id, 'alice')
        registry.complete(record.transfer_id, 'alice')
        registry.release_worker_slot(record.transfer_id, 'alice')

        monkeypatch.setattr('app.transfer_registry.secrets.token_urlsafe',
                            lambda _n: record.transfer_id)
        # No infinite redraw loop: the id is genuinely free now.
        assert _create(registry, user_id='bob').transfer_id == record.transfer_id


class TestOwnershipIsNotAnOracle:
    """Another user's valid id must look exactly like a nonexistent one."""

    def test_cross_user_cancel_fails_and_leaves_the_event_clear(self, registry):
        record = _create(registry, user_id='owner')
        assert registry.cancel(record.transfer_id, 'intruder') is False
        assert record.cancel_event.is_set() is False
        assert record.state is TransferState.PENDING

    def test_unknown_and_cross_user_cancel_return_the_same_result(self, registry):
        record = _create(registry, user_id='owner')
        assert registry.cancel('no-such-transfer', 'intruder') is False
        assert registry.cancel(record.transfer_id, 'intruder') is False
        assert registry.cancel('no-such-transfer', 'owner') is False

    def test_cross_user_get_returns_none(self, registry):
        record = _create(registry, user_id='owner')
        assert registry.get(record.transfer_id, 'intruder') is None

    def test_cross_user_transitions_all_fail(self, registry):
        record = _create(registry, user_id='owner')
        assert registry.mark_running(record.transfer_id, 'intruder') is False
        assert registry.fail(record.transfer_id, 'intruder') is False
        assert registry.complete(record.transfer_id, 'intruder') is False
        assert record.state is TransferState.PENDING

    @pytest.mark.parametrize('bad', [None, '', True])
    def test_malformed_cancel_arguments_are_refused_quietly(self, registry, bad):
        assert registry.cancel(bad, '7') is False
        assert registry.cancel('some-id', bad) is False


class TestExactlyOneTerminalWinner:
    """Monotonic state is what makes the cancel-vs-complete race safe."""

    def test_cancel_beats_a_late_complete(self, registry):
        record = _create(registry)
        registry.mark_running(record.transfer_id, '7')
        assert registry.cancel(record.transfer_id, '7') is True
        # The worker finishes its last chunk and tries to report success.
        assert registry.complete(record.transfer_id, '7') is False
        assert registry.fail(record.transfer_id, '7') is False
        assert record.state is TransferState.CANCELLED

    def test_complete_beats_a_late_cancel(self, registry):
        record = _create(registry)
        registry.mark_running(record.transfer_id, '7')
        assert registry.complete(record.transfer_id, '7') is True
        assert registry.cancel(record.transfer_id, '7') is False
        assert record.state is TransferState.COMPLETED
        # A cancel that lost must not set the event either, or the worker would
        # abort a transfer that already succeeded.
        assert record.cancel_event.is_set() is False

    def test_only_one_of_many_racing_terminals_wins(self, registry):
        record = _create(registry)
        registry.mark_running(record.transfer_id, '7')

        wins = []
        barrier = threading.Barrier(3)

        def attempt(fn):
            barrier.wait()
            wins.append(fn(record.transfer_id, '7'))

        threads = [threading.Thread(target=attempt, args=(fn,))
                   for fn in (registry.cancel, registry.complete, registry.fail)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        assert wins.count(True) == 1

    def test_fail_wins_once_then_never_again(self, registry):
        record = _create(registry)
        registry.mark_running(record.transfer_id, '7')
        assert registry.fail(record.transfer_id, '7') is True
        assert registry.fail(record.transfer_id, '7') is False
        assert registry.complete(record.transfer_id, '7') is False

    def test_complete_requires_running_not_pending(self, registry):
        """A transfer that never started cannot report success."""
        record = _create(registry)
        assert registry.complete(record.transfer_id, '7') is False

    def test_a_terminal_record_is_dropped(self, registry):
        record = _create(registry)
        registry.mark_running(record.transfer_id, '7')
        registry.complete(record.transfer_id, '7')
        assert registry.get(record.transfer_id, '7') is None
        assert registry.active_count('7') == 0


class TestPendingCancelBarrier:
    """Invariant 4: a cancel in the create/start gap must stop the worker."""

    def test_cancel_while_pending_makes_mark_running_fail(self, registry):
        record = _create(registry)
        assert registry.cancel(record.transfer_id, '7') is True
        # The worker thread starts a moment later; this False is its instruction
        # to return WITHOUT opening any SFTP connection.
        assert registry.mark_running(record.transfer_id, '7') is False
        assert record.cancel_event.is_set() is True

    def test_mark_running_is_not_repeatable(self, registry):
        record = _create(registry)
        assert registry.mark_running(record.transfer_id, '7') is True
        assert registry.mark_running(record.transfer_id, '7') is False

    def test_the_pending_cancel_still_sets_the_captured_event(self, registry):
        """A worker that already captured the event sees the cancellation."""
        record = _create(registry)
        captured = record.cancel_event
        registry.cancel(record.transfer_id, '7')
        assert captured.is_set() is True


class TestWorkerMustHoldTheEventObject:
    """Invariant 3: id-based cancellation polling silently stops working."""

    def test_is_cancelled_goes_false_once_the_record_is_dropped(self, registry):
        record = _create(registry)
        registry.mark_running(record.transfer_id, '7')
        registry.cancel(record.transfer_id, '7')
        # This is why a worker may not poll by id: the transfer IS cancelled.
        assert registry.is_cancelled(record.transfer_id, '7') is False
        assert record.cancel_event.is_set() is True

    def test_the_event_object_survives_the_record(self, registry):
        record = _create(registry)
        captured = record.cancel_event
        registry.mark_running(record.transfer_id, '7')
        registry.cancel(record.transfer_id, '7')
        registry.release_worker_slot(record.transfer_id, '7')
        assert captured.is_set() is True


class TestWorkerSlots:
    """Invariant 1: the concurrency ceiling counts threads, not records."""

    def test_the_ceiling_is_enforced(self, registry):
        for _ in range(5):
            _create(registry, user_id='u')
        with pytest.raises(TransferLimitExceeded):
            _create(registry, user_id='u')

    def test_cancelling_five_does_not_free_a_single_slot(self, registry):
        """The start/cancel loop that would otherwise spawn unbounded threads."""
        records = [_create(registry, user_id='u') for _ in range(5)]
        for record in records:
            assert registry.cancel(record.transfer_id, 'u') is True

        # Every record is gone, so a record-counting limit would now allow more.
        assert registry.active_count('u') == 0
        assert registry.worker_slots('u') == 5
        # But the five worker threads are still unwinding their SFTP closes.
        with pytest.raises(TransferLimitExceeded):
            _create(registry, user_id='u')

    def test_a_slot_frees_only_when_the_worker_finally_runs(self, registry):
        records = [_create(registry, user_id='u') for _ in range(5)]
        for record in records:
            registry.cancel(record.transfer_id, 'u')
        with pytest.raises(TransferLimitExceeded):
            _create(registry, user_id='u')

        assert registry.release_worker_slot(records[0].transfer_id, 'u') is True
        assert registry.worker_slots('u') == 4
        # Accepted now, and only now.
        sixth = _create(registry, user_id='u')
        assert sixth.state is TransferState.PENDING

    def test_completion_alone_does_not_free_a_slot(self, registry):
        record = _create(registry, user_id='u')
        registry.mark_running(record.transfer_id, 'u')
        registry.complete(record.transfer_id, 'u')
        assert registry.worker_slots('u') == 1
        registry.release_worker_slot(record.transfer_id, 'u')
        assert registry.worker_slots('u') == 0

    def test_release_is_idempotent_per_transfer(self, registry):
        first = _create(registry, user_id='u')
        _create(registry, user_id='u')
        assert registry.release_worker_slot(first.transfer_id, 'u') is True
        # A second release of the same id must not hand back the other
        # transfer's slot.
        assert registry.release_worker_slot(first.transfer_id, 'u') is False
        assert registry.worker_slots('u') == 1

    def test_release_of_an_unknown_id_changes_nothing(self, registry):
        _create(registry, user_id='u')
        assert registry.release_worker_slot('never-issued', 'u') is False
        assert registry.worker_slots('u') == 1

    def test_a_never_started_worker_still_releases_its_slot(self, registry):
        """Thread-spawn failure must not leak the slot it reserved."""
        record = _create(registry, user_id='u')
        registry.fail(record.transfer_id, 'u')
        registry.release_worker_slot(record.transfer_id, 'u')
        assert registry.worker_slots('u') == 0

    def test_slots_are_per_user(self, registry):
        for _ in range(5):
            _create(registry, user_id='alice')
        # Alice being at her ceiling must not block Bob.
        assert _create(registry, user_id='bob') is not None
        assert registry.worker_slots('bob') == 1

    def test_the_ceiling_is_configurable_and_validated(self):
        assert TransferRegistry(max_active_per_user=1) is not None
        for bad in (0, -1, True, 1.5, None, '3'):
            with pytest.raises(ValueError):
                TransferRegistry(max_active_per_user=bad)

    def test_slots_survive_concurrent_create_attempts(self):
        """The ceiling holds under real contention, not just serial calls."""
        registry = TransferRegistry(max_active_per_user=3)
        created = []
        refused = []
        barrier = threading.Barrier(10)

        def attempt():
            barrier.wait()
            try:
                created.append(_create(registry, user_id='u'))
            except TransferLimitExceeded:
                refused.append(True)

        threads = [threading.Thread(target=attempt) for _ in range(10)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        assert len(created) == 3
        assert len(refused) == 7
        assert registry.worker_slots('u') == 3


class TestSlotReleaseIsOwnerChecked:
    """Invariant 6: one user must not be able to release another's slot.

    The bare membership test was worse than it looks. Releasing Bob's id from
    Alice's call decremented ALICE's count (freeing a slot she never held) and
    deleted the id, so Bob's own worker finally found the id gone, returned
    False, and leaked Bob's slot for the life of the process.
    """

    def test_alice_cannot_release_bobs_id(self, registry):
        bob = _create(registry, user_id='bob')
        assert registry.release_worker_slot(bob.transfer_id, 'alice') is False

    def test_bobs_slot_is_not_leaked_by_alices_attempt(self, registry):
        bob = _create(registry, user_id='bob')
        registry.release_worker_slot(bob.transfer_id, 'alice')
        # Bob still holds his slot...
        assert registry.worker_slots('bob') == 1
        # ...and his own release still works, exactly once.
        assert registry.release_worker_slot(bob.transfer_id, 'bob') is True
        assert registry.worker_slots('bob') == 0

    def test_alices_own_slots_are_untouched_by_a_failed_attempt(self, registry):
        alice = _create(registry, user_id='alice')
        bob = _create(registry, user_id='bob')
        registry.release_worker_slot(bob.transfer_id, 'alice')
        assert registry.worker_slots('alice') == 1
        assert registry.release_worker_slot(alice.transfer_id, 'alice') is True
        assert registry.worker_slots('alice') == 0

    def test_a_cross_user_attempt_cannot_free_a_ceiling_slot(self, registry):
        """The abuse this enables: evicting a victim from their own ceiling."""
        victim_ids = [_create(registry, user_id='victim').transfer_id
                      for _ in range(5)]
        for transfer_id in victim_ids:
            assert registry.release_worker_slot(transfer_id, 'attacker') is False
        assert registry.worker_slots('victim') == 5
        with pytest.raises(TransferLimitExceeded):
            _create(registry, user_id='victim')

    def test_release_still_works_across_id_types(self, registry):
        record = _create(registry, user_id=11)
        assert registry.release_worker_slot(record.transfer_id, '11') is True

    def test_an_id_released_by_its_owner_becomes_reusable(self, registry,
                                                         monkeypatch):
        record = _create(registry, user_id='alice')
        registry.release_worker_slot(record.transfer_id, 'alice')
        monkeypatch.setattr('app.transfer_registry.secrets.token_urlsafe',
                            lambda _n: record.transfer_id)
        assert _create(registry, user_id='bob').transfer_id == record.transfer_id


class TestOwnerSidNormalization:
    """Invariant 6: owner_sid follows the same id rules as everything else."""

    @pytest.mark.parametrize('bad', ['', '   ', True, False, 1.5, object(), []])
    def test_invalid_owner_sids_are_refused_at_create(self, registry, bad):
        with pytest.raises(ValueError):
            _create(registry, user_id='u', owner_sid=bad)

    def test_a_refused_owner_sid_consumes_no_slot(self, registry):
        with pytest.raises(ValueError):
            _create(registry, user_id='u', owner_sid='')
        assert registry.worker_slots('u') == 0
        assert registry.active_count('u') == 0

    def test_none_is_still_allowed_and_means_no_socket(self, registry):
        record = _create(registry, user_id='u', owner_sid=None)
        assert record.owner_sid is None
        assert registry.cancel_all_for_socket('u', 'any-sid') == 0

    def test_owner_sid_is_stripped_and_stringified(self, registry):
        record = _create(registry, user_id='u', owner_sid='  sid-7  ')
        assert record.owner_sid == 'sid-7'
        numeric = _create(registry, user_id='u', owner_sid=42)
        assert numeric.owner_sid == '42'

    def test_cancel_all_for_socket_matches_a_normalized_sid(self, registry):
        record = _create(registry, user_id='u', owner_sid='  sid-7 ')
        # Presented with surrounding whitespace, it still matches the record.
        assert registry.cancel_all_for_socket('u', 'sid-7 ') == 1
        assert record.cancel_event.is_set() is True

    def test_cancel_all_for_socket_matches_an_int_sid(self, registry):
        record = _create(registry, user_id='u', owner_sid=42)
        assert registry.cancel_all_for_socket('u', '42') == 1
        assert record.cancel_event.is_set() is True

    @pytest.mark.parametrize('bad', [None, '', '  ', True, 1.5])
    def test_an_invalid_sid_cancels_nothing_and_does_not_raise(self, registry, bad):
        record = _create(registry, user_id='u', owner_sid='sid-real')
        assert registry.cancel_all_for_socket('u', bad) == 0
        assert record.cancel_event.is_set() is False

    def test_a_non_matching_sid_cancels_nothing(self, registry):
        record = _create(registry, user_id='u', owner_sid='sid-1')
        assert registry.cancel_all_for_socket('u', 'sid-2') == 0
        assert record.cancel_event.is_set() is False


class TestDisconnectScope:
    """Invariant 5: one tab disconnecting must not cancel another tab's work."""

    def test_cancel_all_for_socket_spares_the_other_tab(self, registry):
        tab_one = _create(registry, user_id='u', owner_sid='sid-1')
        tab_two = _create(registry, user_id='u', owner_sid='sid-2')

        assert registry.cancel_all_for_socket('u', 'sid-1') == 1
        assert tab_one.cancel_event.is_set() is True
        assert tab_two.cancel_event.is_set() is False
        assert registry.get(tab_two.transfer_id, 'u') is tab_two

    def test_cancel_all_for_socket_spares_other_users(self, registry):
        mine = _create(registry, user_id='alice', owner_sid='shared-sid')
        theirs = _create(registry, user_id='bob', owner_sid='shared-sid')
        assert registry.cancel_all_for_socket('alice', 'shared-sid') == 1
        assert mine.cancel_event.is_set() is True
        assert theirs.cancel_event.is_set() is False

    def test_a_missing_sid_cancels_nothing(self, registry):
        record = _create(registry, user_id='u', owner_sid=None)
        assert registry.cancel_all_for_socket('u', None) == 0
        assert registry.cancel_all_for_socket('u', '') == 0
        assert record.cancel_event.is_set() is False

    def test_cancel_all_for_user_covers_every_socket(self, registry):
        """Reserved for a verified last-socket disconnect or logout."""
        first = _create(registry, user_id='u', owner_sid='sid-1')
        second = _create(registry, user_id='u', owner_sid='sid-2')
        other = _create(registry, user_id='other', owner_sid='sid-3')

        assert registry.cancel_all_for_user('u') == 2
        assert first.cancel_event.is_set() is True
        assert second.cancel_event.is_set() is True
        assert other.cancel_event.is_set() is False

    def test_disconnect_cancellation_does_not_free_slots(self, registry):
        _create(registry, user_id='u', owner_sid='sid-1')
        registry.cancel_all_for_socket('u', 'sid-1')
        # Same reason as an explicit cancel: the worker is still unwinding.
        assert registry.worker_slots('u') == 1

    def test_disconnect_cancellation_skips_already_terminal_records(self, registry):
        record = _create(registry, user_id='u', owner_sid='sid-1')
        registry.mark_running(record.transfer_id, 'u')
        registry.complete(record.transfer_id, 'u')
        assert registry.cancel_all_for_socket('u', 'sid-1') == 0
        assert record.cancel_event.is_set() is False
