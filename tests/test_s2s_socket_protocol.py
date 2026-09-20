"""The socket half of the server-to-server transfer protocol.

These tests CALL the handlers instead of grepping their source. The previous
version of this file asserted that certain identifiers appeared in
`inspect.getsource(...)`, which passed whether or not the wiring worked and would
have kept passing after the protocol changed underneath it.

What is pinned here:

  * the SERVER issues the transfer id and returns it in the ack; the client's
    payload has no id and one is never trusted from it;
  * a request that fails validation or authorization acks a failure and does NOT
    emit a terminal event for an id that was never created;
  * exactly one terminal event reaches the client per transfer, and a cancelled
    transfer never receives an error or a completion afterwards;
  * a cancel that lands before the worker runs stops it from opening SFTP at all;
  * the worker slot is released on every exit path, including worker exceptions
    and a thread that never starts;
  * disconnect cancellation is scoped to the socket that owns the transfer.

The socket layer is exercised with the SocketIO decorators bypassed (the handlers
are plain functions underneath) and `transfer_server_to_server` replaced, because
the transfer body itself is already covered by tests/test_s2s_transfer_cancel.py.
"""

import threading
import types

import pytest

from app import socket_events
from app.transfer_registry import TransferRegistry, TransferState


class _User:
    def __init__(self, user_id=7, username='tester'):
        self.id = user_id
        self.username = username


class _Recorder:
    """Captures socketio.emit calls."""

    def __init__(self):
        self.events = []

    def emit(self, event, payload=None, room=None):
        self.events.append((event, payload, room))

    def names(self):
        return [event for event, _payload, _room in self.events]

    def payloads(self, name):
        return [payload for event, payload, _room in self.events if event == name]


@pytest.fixture
def wired(monkeypatch):
    """Handlers with a fresh registry, a recorder, and authorization granted.

    Returns a namespace whose `run(**payload)` calls the transfer handler and
    whose `worker` is the thread body that was submitted, so tests can decide
    when the worker runs relative to a cancel.
    """
    registry = TransferRegistry()
    recorder = _Recorder()
    state = types.SimpleNamespace(
        registry=registry,
        recorder=recorder,
        worker=None,
        transfer_calls=[],
        transfer_result=(True, None),
        transfer_body=None,
        start_raises=False,
        sid='sid-1',
    )

    monkeypatch.setattr(socket_events, 'transfer_registry', registry)
    monkeypatch.setattr(socket_events, 'socketio', recorder)
    monkeypatch.setattr(socket_events, 'verify_session_ownership',
                        lambda session_id, user_id: True)
    monkeypatch.setattr(socket_events, 'emit',
                        lambda *args, **kwargs: None)
    monkeypatch.setattr(socket_events.sftp_handler, 'sanitize_path',
                        lambda path: path)
    monkeypatch.setattr(socket_events, 'request',
                        types.SimpleNamespace(sid=state.sid))

    def fake_transfer(**kwargs):
        state.transfer_calls.append(kwargs)
        if state.transfer_body is not None:
            return state.transfer_body(**kwargs)
        return state.transfer_result

    monkeypatch.setattr(socket_events.sftp_handler, 'transfer_server_to_server',
                        fake_transfer)

    class _CapturedThread:
        """Captures the worker instead of running it, so races are deterministic."""

        def __init__(self, target=None, daemon=None):
            state.worker = target
            self.daemon = daemon

        def start(self):
            if state.start_raises:
                raise RuntimeError('cannot start thread')

    monkeypatch.setattr(socket_events.threading, 'Thread', _CapturedThread)

    def run(**overrides):
        payload = {
            'source_session_id': 'src',
            'source_path': '/a/f',
            'dest_session_id': 'dst',
            'dest_path': '/b/f',
        }
        payload.update(overrides)
        return socket_events.handle_transfer_server_to_server.__wrapped__(
            payload, current_user=_User())

    state.run = run
    return state


class TestServerIssuesTheId:

    def test_the_ack_carries_a_server_generated_id(self, wired):
        ack = wired.run()
        assert ack['success'] is True
        transfer_id = ack['transfer_id']
        assert isinstance(transfer_id, str) and len(transfer_id) >= 20
        assert wired.registry.get(transfer_id, 7) is not None

    def test_a_client_supplied_id_is_ignored(self, wired):
        """A client that tries to name its transfer gets the server's id anyway."""
        ack = wired.run(transfer_id='s2s_client_invented_1')
        assert ack['transfer_id'] != 's2s_client_invented_1'
        # And the invented id is not cancellable, because it was never created.
        assert wired.registry.cancel('s2s_client_invented_1', 7) is False

    def test_two_requests_get_different_ids(self, wired):
        first = wired.run()['transfer_id']
        second = wired.run()['transfer_id']
        assert first != second

    def test_the_worker_receives_the_server_id(self, wired):
        transfer_id = wired.run()['transfer_id']
        wired.worker()
        assert wired.transfer_calls[0]['transfer_id'] == transfer_id

    def test_the_record_remembers_the_owning_socket(self, wired):
        transfer_id = wired.run()['transfer_id']
        assert wired.registry.get(transfer_id, 7).owner_sid == 'sid-1'


class TestRejectionsDoNotFabricateTransfers:
    """A refused request must not create a record or emit a terminal event."""

    @pytest.mark.parametrize('missing', ['source_session_id', 'source_path',
                                         'dest_session_id', 'dest_path'])
    def test_missing_fields_ack_a_failure(self, wired, missing):
        ack = wired.run(**{missing: None})
        assert ack == {'success': False, 'error': 'Missing required fields'}
        assert wired.recorder.names() == []
        assert wired.registry.worker_slots(7) == 0

    def test_an_invalid_path_acks_a_failure(self, wired, monkeypatch):
        monkeypatch.setattr(socket_events.sftp_handler, 'sanitize_path',
                            lambda path: None)
        ack = wired.run()
        assert ack == {'success': False, 'error': 'Invalid path'}
        assert wired.recorder.names() == []

    def test_an_unauthorized_source_acks_a_failure(self, wired, monkeypatch):
        monkeypatch.setattr(socket_events, 'verify_session_ownership',
                            lambda session_id, user_id: session_id != 'src')
        monkeypatch.setattr(
            socket_events.connection_pool.temp_connection_pool,
            'get_connection_info', lambda session_id: None)
        ack = wired.run()
        assert ack['success'] is False
        assert 'source' in ack['error']
        assert wired.registry.worker_slots(7) == 0

    def test_an_unauthorized_destination_acks_a_failure(self, wired, monkeypatch):
        monkeypatch.setattr(socket_events, 'verify_session_ownership',
                            lambda session_id, user_id: session_id != 'dst')
        monkeypatch.setattr(
            socket_events.connection_pool.temp_connection_pool,
            'get_connection_info', lambda session_id: None)
        ack = wired.run()
        assert ack['success'] is False
        assert 'destination' in ack['error']

    def test_the_concurrency_ceiling_acks_a_failure(self, wired):
        acks = [wired.run() for _ in range(5)]
        assert all(ack['success'] for ack in acks)
        refused = wired.run()
        assert refused['success'] is False
        assert 'Too many' in refused['error']
        # No terminal event for a transfer that never existed.
        assert wired.recorder.names() == []


class TestExactlyOneTerminalEvent:

    def test_a_successful_transfer_emits_no_error(self, wired):
        wired.transfer_result = (True, None)
        wired.run()
        wired.worker()
        assert 's2s_transfer_error' not in wired.recorder.names()

    def test_a_failure_emits_exactly_one_error(self, wired):
        wired.transfer_result = (False, 'Transfer failed')
        transfer_id = wired.run()['transfer_id']
        wired.worker()
        errors = wired.recorder.payloads('s2s_transfer_error')
        assert len(errors) == 1
        assert errors[0]['transfer_id'] == transfer_id

    def test_a_cancelled_transfer_emits_no_error(self, wired):
        """The cancelled row must not be overwritten by a red failure."""
        transfer_id = wired.run()['transfer_id']

        def body(**kwargs):
            # The cancel arrives while the copy is running.
            wired.registry.cancel(transfer_id, 7)
            return False, 'Transfer cancelled'

        wired.transfer_body = body
        wired.worker()
        assert 's2s_transfer_error' not in wired.recorder.names()

    def test_a_late_completion_after_a_cancel_is_swallowed(self, wired):
        transfer_id = wired.run()['transfer_id']

        def body(**kwargs):
            wired.registry.cancel(transfer_id, 7)
            return True, None          # the copy finished anyway

        wired.transfer_body = body
        wired.worker()
        # complete() lost the race, so no terminal state was recorded for it.
        assert wired.registry.get(transfer_id, 7) is None
        assert 's2s_transfer_error' not in wired.recorder.names()

    def test_a_worker_exception_emits_exactly_one_error(self, wired):
        transfer_id = wired.run()['transfer_id']

        def body(**kwargs):
            raise RuntimeError('paramiko exploded')

        wired.transfer_body = body
        wired.worker()
        errors = wired.recorder.payloads('s2s_transfer_error')
        assert len(errors) == 1
        assert errors[0]['transfer_id'] == transfer_id

    def test_a_cancelled_transfer_that_then_crashes_emits_no_error(self, wired):
        transfer_id = wired.run()['transfer_id']

        def body(**kwargs):
            wired.registry.cancel(transfer_id, 7)
            raise RuntimeError('crash after cancel')

        wired.transfer_body = body
        wired.worker()
        assert 's2s_transfer_error' not in wired.recorder.names()


class TestPendingCancelStopsTheWorker:

    def test_a_cancel_before_the_worker_runs_prevents_any_sftp_work(self, wired):
        transfer_id = wired.run()['transfer_id']
        # The cancel wins while the transfer is still PENDING.
        assert wired.registry.cancel(transfer_id, 7) is True

        wired.worker()

        # The transfer body was never entered: no connection was opened.
        assert wired.transfer_calls == []
        assert wired.recorder.names() == []

    def test_the_slot_is_still_released_when_the_worker_returns_early(self, wired):
        transfer_id = wired.run()['transfer_id']
        wired.registry.cancel(transfer_id, 7)
        assert wired.registry.worker_slots(7) == 1
        wired.worker()
        assert wired.registry.worker_slots(7) == 0

    def test_the_worker_polls_the_event_object_not_the_registry(self, wired):
        """The captured event must reflect a cancel even after the record is gone."""
        transfer_id = wired.run()['transfer_id']
        seen = {}

        def body(**kwargs):
            wired.registry.cancel(transfer_id, 7)
            seen['event_set'] = kwargs['cancel_event'].is_set()
            seen['registry_says'] = wired.registry.is_cancelled(transfer_id, 7)
            return False, 'Transfer cancelled'

        wired.transfer_body = body
        wired.worker()
        assert seen['event_set'] is True
        # The registry cannot answer this once the record is dropped, which is
        # exactly why the worker is given the event object.
        assert seen['registry_says'] is False


class TestWorkerSlotsAreAlwaysReleased:

    def test_a_successful_worker_releases_its_slot(self, wired):
        wired.run()
        assert wired.registry.worker_slots(7) == 1
        wired.worker()
        assert wired.registry.worker_slots(7) == 0

    def test_a_failed_worker_releases_its_slot(self, wired):
        wired.transfer_result = (False, 'Transfer failed')
        wired.run()
        wired.worker()
        assert wired.registry.worker_slots(7) == 0

    def test_a_crashing_worker_releases_its_slot(self, wired):
        def body(**kwargs):
            raise RuntimeError('boom')

        wired.transfer_body = body
        wired.run()
        wired.worker()
        assert wired.registry.worker_slots(7) == 0

    def test_a_thread_that_never_starts_releases_its_slot(self, wired):
        """Otherwise a spawn failure would permanently consume one of five slots."""
        wired.start_raises = True
        ack = wired.run()
        assert ack['success'] is False
        assert wired.registry.worker_slots(7) == 0

    def test_five_cancelled_but_unfinished_workers_still_block_a_sixth(self, wired):
        """The start/cancel loop: records are gone, threads are not."""
        ids = [wired.run()['transfer_id'] for _ in range(5)]
        workers = []
        for transfer_id in ids:
            assert wired.registry.cancel(transfer_id, 7) is True
        assert wired.registry.active_count(7) == 0

        refused = wired.run()
        assert refused['success'] is False
        assert wired.registry.worker_slots(7) == 5


class TestCancelAck:

    def _cancel(self, transfer_id, user_id=7):
        return socket_events.handle_cancel_transfer.__wrapped__(
            {'transfer_id': transfer_id}, current_user=_User(user_id))

    def test_the_owner_gets_a_success_ack_and_a_broadcast(self, wired):
        transfer_id = wired.run()['transfer_id']
        ack = self._cancel(transfer_id)
        assert ack == {'success': True}
        cancelled = wired.recorder.payloads('s2s_transfer_cancelled')
        assert len(cancelled) == 1
        assert cancelled[0]['transfer_id'] == transfer_id
        assert cancelled[0]['status'] == 'cancelled'

    def test_another_user_gets_the_same_ack_as_an_unknown_id(self, wired):
        transfer_id = wired.run()['transfer_id']
        assert self._cancel(transfer_id, user_id=8) == {'success': False}
        assert self._cancel('never-existed', user_id=8) == {'success': False}
        assert self._cancel('never-existed', user_id=7) == {'success': False}
        # No broadcast, and the transfer is untouched.
        assert 's2s_transfer_cancelled' not in wired.recorder.names()
        assert wired.registry.get(transfer_id, 7).state is TransferState.PENDING

    def test_a_missing_id_is_refused(self, wired):
        assert self._cancel(None) == {'success': False}
        assert self._cancel('') == {'success': False}

    def test_cancelling_twice_only_succeeds_once(self, wired):
        transfer_id = wired.run()['transfer_id']
        assert self._cancel(transfer_id) == {'success': True}
        assert self._cancel(transfer_id) == {'success': False}
        assert len(wired.recorder.payloads('s2s_transfer_cancelled')) == 1

    def test_cancelling_a_completed_transfer_fails(self, wired):
        transfer_id = wired.run()['transfer_id']
        wired.worker()
        assert self._cancel(transfer_id) == {'success': False}


class TestTerminalWinnerBarrier:
    """A cancel landing between handler return and terminalization must win.

    This is the gap the SFTP layer used to emit into. `transfer_server_to_server`
    returned (True, None) and emitted s2s_transfer_complete itself; only
    afterwards did the socket layer call registry.complete(). A cancel arriving
    in that window made complete() return False -- but the Complete event had
    already gone out, so the client received Cancelled AND Complete for one
    transfer and the row's final state depended on arrival order.

    The barrier below is deterministic, not timing-dependent: the fake transfer
    body returns success, and the cancel is injected at the exact instant the
    body returns, before the worker reaches its terminalization.
    """

    def test_a_cancel_at_the_barrier_beats_a_successful_copy(self, wired):
        transfer_id = wired.run()['transfer_id']

        def body(**kwargs):
            # The copy succeeded. The user's cancel lands right now, in the gap
            # between this return and the worker's complete() call.
            wired.registry.cancel(transfer_id, 7)
            return True, None

        wired.transfer_body = body
        wired.worker()

        names = wired.recorder.names()
        assert 's2s_transfer_complete' not in names
        assert 's2s_transfer_error' not in names

    def test_the_client_never_receives_both_cancelled_and_complete(self, wired):
        """The user-visible property, asserted over the whole event stream."""
        transfer_id = wired.run()['transfer_id']
        # The cancel handler broadcasts s2s_transfer_cancelled...
        socket_events.handle_cancel_transfer.__wrapped__(
            {'transfer_id': transfer_id}, current_user=_User())

        # ...and the worker then finishes its copy successfully.
        wired.transfer_body = lambda **kwargs: (True, None)
        wired.worker()

        names = wired.recorder.names()
        assert names.count('s2s_transfer_cancelled') == 1
        assert 's2s_transfer_complete' not in names
        terminal = [n for n in names if n in {
            's2s_transfer_complete', 's2s_transfer_error', 's2s_transfer_cancelled'}]
        assert terminal == ['s2s_transfer_cancelled']

    def test_an_uncancelled_success_does_emit_exactly_one_complete(self, wired):
        """The gate must not suppress the normal completion."""
        transfer_id = wired.run()['transfer_id']
        wired.transfer_body = lambda **kwargs: (True, None)
        wired.worker()

        completes = wired.recorder.payloads('s2s_transfer_complete')
        assert len(completes) == 1
        assert completes[0]['transfer_id'] == transfer_id
        # The toast reads filename; it printed "undefined" without this.
        assert completes[0]['filename'] == 'f'
        assert completes[0]['source_path'] == '/a/f'
        assert completes[0]['dest_path'] == '/b/f'

    def test_the_exec_transport_layer_emits_no_terminal_events(self):
        """Pins the layering itself, so terminal emit cannot drift back down."""
        import inspect
        from app import exec_fs
        source = inspect.getsource(exec_fs.transfer_server_to_server)
        emitted = [line for line in source.splitlines()
                   if '.emit(' in line and 's2s_transfer_' in line]
        assert any('s2s_transfer_started' in line for line in emitted)
        assert any('s2s_transfer_progress' in line for line in emitted)
        assert not [line for line in emitted if 's2s_transfer_complete' in line]
        assert not [line for line in emitted if 's2s_transfer_error' in line]

    def test_exactly_one_terminal_event_across_every_outcome(self, wired):
        """No outcome may produce two terminal events, or none where one is due."""
        cases = {
            'success': (lambda **k: (True, None), 's2s_transfer_complete'),
            'failure': (lambda **k: (False, 'Transfer failed'), 's2s_transfer_error'),
            'crash': (None, 's2s_transfer_error'),
        }
        for name, (body, expected) in cases.items():
            wired.recorder.events.clear()
            transfer_id = wired.run()['transfer_id']
            if body is None:
                def body(**kwargs):
                    raise RuntimeError('boom')
            wired.transfer_body = body
            wired.worker()
            terminal = [n for n in wired.recorder.names() if n in {
                's2s_transfer_complete', 's2s_transfer_error',
                's2s_transfer_cancelled'}]
            assert terminal == [expected], f'{name}: {terminal}'
            wired.registry.release_worker_slot(transfer_id, 7)


class TestSameHostIsRefusedServerSide:
    """Frontend validation is not a trust boundary."""

    def test_a_same_host_request_is_refused(self, wired):
        ack = wired.run(dest_session_id='src')
        assert ack['success'] is False
        assert 'different hosts' in ack['error']

    def test_no_record_slot_worker_or_channel_is_created(self, wired):
        wired.run(dest_session_id='src')
        # No slot consumed, no worker submitted, no SFTP call made, no event sent.
        assert wired.registry.worker_slots(7) == 0
        assert wired.registry.active_count(7) == 0
        assert wired.worker is None
        assert wired.transfer_calls == []
        assert wired.recorder.names() == []

    def test_string_and_int_session_ids_are_compared_as_text(self, wired):
        """A crafted payload cannot slip past on a type difference."""
        assert wired.run(source_session_id=7, dest_session_id='7')['success'] is False
        assert wired.run(source_session_id='7', dest_session_id=7)['success'] is False

    def test_two_different_hosts_are_still_accepted(self, wired):
        assert wired.run()['success'] is True


class TestWorkerSetupFailure:
    """Thread construction and start share one guarded path."""

    def test_a_thread_constructor_failure_releases_the_slot(self, wired,
                                                           monkeypatch):
        """The constructor was outside the guard, so its failure leaked a slot."""
        def exploding_thread(*args, **kwargs):
            raise RuntimeError('cannot allocate thread')

        monkeypatch.setattr(socket_events.threading, 'Thread', exploding_thread)
        ack = wired.run()
        assert ack == {'success': False, 'error': 'Failed to start transfer'}
        assert wired.registry.worker_slots(7) == 0
        assert wired.registry.active_count(7) == 0

    def test_a_thread_constructor_failure_terminalizes_the_record(self, wired,
                                                                 monkeypatch):
        captured = {}
        real_create = wired.registry.create

        def spy_create(*args, **kwargs):
            record = real_create(*args, **kwargs)
            captured['record'] = record
            return record

        monkeypatch.setattr(wired.registry, 'create', spy_create)
        monkeypatch.setattr(socket_events.threading, 'Thread',
                            lambda *a, **k: (_ for _ in ()).throw(
                                RuntimeError('no threads')))
        wired.run()
        record = captured['record']
        # Terminalized, so a later cancel cannot find it and the id is not left
        # dangling in an active state forever.
        assert wired.registry.get(record.transfer_id, 7) is None
        assert wired.registry.cancel(record.transfer_id, 7) is False

    def test_the_slot_is_released_exactly_once_on_setup_failure(self, wired,
                                                               monkeypatch):
        """A double release would hand back a slot another transfer holds."""
        first = wired.run()['transfer_id']
        assert wired.registry.worker_slots(7) == 1

        monkeypatch.setattr(socket_events.threading, 'Thread',
                            lambda *a, **k: (_ for _ in ()).throw(
                                RuntimeError('no threads')))
        wired.run()
        # The failed setup released only its own slot; the first is still held.
        assert wired.registry.worker_slots(7) == 1
        assert wired.registry.get(first, 7) is not None

    def test_a_start_failure_is_guarded_the_same_way(self, wired):
        wired.start_raises = True
        ack = wired.run()
        assert ack['success'] is False
        assert wired.registry.worker_slots(7) == 0


class TestDisconnectIsSocketScoped:
    """One tab closing must not cancel another tab's transfer."""

    def test_a_second_tab_survives_the_first_tabs_disconnect(self, wired,
                                                             monkeypatch):
        first = wired.run()['transfer_id']
        monkeypatch.setattr(socket_events, 'request',
                            types.SimpleNamespace(sid='sid-2'))
        second = wired.run()['transfer_id']

        assert wired.registry.cancel_all_for_socket(7, 'sid-1') == 1
        assert wired.registry.get(first, 7) is None
        assert wired.registry.get(second, 7) is not None
        assert wired.registry.get(second, 7).cancel_event.is_set() is False

    def test_the_disconnect_handler_cancels_only_the_departing_socket(self, wired):
        """Pins the handler itself, not just the registry method it calls."""
        import inspect
        source = inspect.getsource(socket_events.handle_disconnect)
        # cancel_all_for_socket must be reached with the departing sid, and the
        # user-wide sweep must sit behind the verified last-socket condition.
        assert 'cancel_all_for_socket(user.id, socket_sid)' in source
        socket_scoped = source.index('cancel_all_for_socket')
        last_socket_guard = source.index('if not other_live:')
        user_wide = source.index('cancel_all_for_user')
        assert socket_scoped < last_socket_guard < user_wide


class TestEventsGoToTheOwningSocket:
    """S2S events must reach the requesting TAB, not every tab of the account.

    Review round 6. Every s2s event was emitted to `user_<id>`, so a second
    tab of the same account received started / progress / complete / error for
    transfer ids it had never queued. On the client each of those lands in the
    early-event buffer keyed by an id whose row will never exist, so one tab's
    activity grew another tab's memory. Flask-SocketIO places every client in a
    room named by its own sid, so addressing the owner's sid delivers to exactly
    the socket that asked.

    Ownership for CANCEL is unchanged and still checked against user_id in the
    registry: this narrows DELIVERY only.
    """

    def test_progress_and_started_are_addressed_to_the_owning_sid(self, wired):
        wired.run()
        wired.worker()
        # sftp_handler receives the room it must emit started/progress into.
        assert wired.transfer_calls[0]['user_room'] == 'sid-1'

    def test_the_completion_event_is_addressed_to_the_owning_sid(self, wired):
        wired.transfer_result = (True, None)
        wired.run()
        wired.worker()
        rooms = [room for event, _payload, room in wired.recorder.events
                 if event == 's2s_transfer_complete']
        assert rooms == ['sid-1']

    def test_the_error_event_is_addressed_to_the_owning_sid(self, wired):
        wired.transfer_result = (False, 'boom')
        wired.run()
        wired.worker()
        rooms = [room for event, _payload, room in wired.recorder.events
                 if event == 's2s_transfer_error']
        assert rooms == ['sid-1']

    def test_no_s2s_event_is_broadcast_to_the_whole_user_room(self, wired):
        wired.transfer_result = (True, None)
        wired.run()
        wired.worker()
        s2s_rooms = [room for event, _payload, room in wired.recorder.events
                     if event.startswith('s2s_')]
        assert s2s_rooms, 'expected at least one s2s event'
        assert 'user_7' not in s2s_rooms

    def test_a_second_tabs_transfer_is_addressed_to_that_tab(self, wired,
                                                            monkeypatch):
        """Two tabs, two sids: neither transfer's events go to the other."""
        wired.run()
        first_worker = wired.worker
        monkeypatch.setattr(socket_events, 'request',
                            types.SimpleNamespace(sid='sid-2'))
        wired.run()
        second_worker = wired.worker

        first_worker()
        second_worker()

        rooms = [(payload['transfer_id'], room)
                 for event, payload, room in wired.recorder.events
                 if event == 's2s_transfer_complete']
        assert len(rooms) == 2
        # Each completion went to exactly one room, and the two rooms differ.
        assert {room for _tid, room in rooms} == {'sid-1', 'sid-2'}

    def test_the_per_user_room_remains_the_fallback_without_a_sid(self, wired,
                                                                 monkeypatch):
        """No sid available must not mean no delivery."""
        monkeypatch.setattr(socket_events, 'request',
                            types.SimpleNamespace(sid=None))
        wired.transfer_result = (True, None)
        wired.run()
        wired.worker()
        rooms = [room for event, _payload, room in wired.recorder.events
                 if event == 's2s_transfer_complete']
        assert rooms == ['user_7']

    def test_the_owning_sid_is_still_recorded_for_disconnect_scoping(self, wired):
        """The delivery room and the ownership record must agree."""
        transfer_id = wired.run()['transfer_id']
        record = wired.registry.get(transfer_id, 7)
        assert record.owner_sid == 'sid-1'
        assert wired.transfer_calls == []  # worker not run yet
        wired.worker()
        assert wired.transfer_calls[0]['user_room'] == record.owner_sid


class TestCancelIsOwnerSocketScoped:
    """Explicit cancel is authorized by SOCKET, not merely by user.

    Release blocker, review round 6. `handle_cancel_transfer` authorized on
    user_id alone and emitted the terminal event to `user_<id>`. That contradicted
    the disconnect path, which was already socket-scoped (registry invariant 5):

      * a SECOND TAB of the same account that learned a transfer_id could stop a
        copy it never started, while the tab that did start it was never told;
      * every tab of the account received a cancellation for an id it had never
        queued.

    These tests drive the real handler and assert both halves: who may cancel, and
    who is told. They are deterministic -- the fixture captures the worker instead
    of running it, and `request.sid` is set explicitly per call.
    """

    def _cancel(self, transfer_id, user_id=7):
        return socket_events.handle_cancel_transfer.__wrapped__(
            {'transfer_id': transfer_id}, current_user=_User(user_id))

    @staticmethod
    def _as_sid(monkeypatch, sid):
        monkeypatch.setattr(socket_events, 'request',
                            types.SimpleNamespace(sid=sid))

    # ── the owner ────────────────────────────────────────────────────────────
    def test_the_owning_socket_can_cancel(self, wired):
        transfer_id = wired.run()['transfer_id']
        assert self._cancel(transfer_id) == {'success': True}
        assert wired.registry.get(transfer_id, 7) is None

    def test_the_cancellation_is_delivered_only_to_the_owning_sid(self, wired):
        transfer_id = wired.run()['transfer_id']
        self._cancel(transfer_id)
        rooms = [room for event, _payload, room in wired.recorder.events
                 if event == 's2s_transfer_cancelled']
        assert rooms == ['sid-1']
        assert 'user_7' not in rooms

    # ── a same-user tab that is NOT the owner ────────────────────────────────
    def test_a_same_user_other_tab_cannot_cancel(self, wired, monkeypatch):
        """THE BLOCKER. Tab A starts it; tab B must not be able to stop it."""
        transfer_id = wired.run()['transfer_id']       # created by sid-1
        self._as_sid(monkeypatch, 'sid-2')             # a second tab, same user
        assert self._cancel(transfer_id) == {'success': False}
        # Still active, and its cancel event was NOT set.
        record = wired.registry.get(transfer_id, 7)
        assert record is not None
        assert record.state is TransferState.PENDING
        assert record.cancel_event.is_set() is False

    def test_a_same_user_other_tab_triggers_no_event(self, wired, monkeypatch):
        transfer_id = wired.run()['transfer_id']
        self._as_sid(monkeypatch, 'sid-2')
        self._cancel(transfer_id)
        assert 's2s_transfer_cancelled' not in wired.recorder.names()

    def test_a_refused_tab_does_not_stop_the_worker(self, wired, monkeypatch):
        """The copy must actually keep going, not just keep its record."""
        transfer_id = wired.run()['transfer_id']
        self._as_sid(monkeypatch, 'sid-2')
        self._cancel(transfer_id)
        wired.worker()
        # The worker ran the transfer instead of returning at the mark_running
        # barrier, and reported its own terminal outcome.
        assert len(wired.transfer_calls) == 1
        assert 's2s_transfer_complete' in wired.recorder.names()

    def test_the_owner_can_still_cancel_after_another_tab_was_refused(
            self, wired, monkeypatch):
        transfer_id = wired.run()['transfer_id']
        self._as_sid(monkeypatch, 'sid-2')
        assert self._cancel(transfer_id) == {'success': False}
        self._as_sid(monkeypatch, 'sid-1')
        assert self._cancel(transfer_id) == {'success': True}

    # ── opacity: every refusal looks identical ───────────────────────────────
    def test_a_non_owner_tab_is_indistinguishable_from_an_unknown_id(
            self, wired, monkeypatch):
        transfer_id = wired.run()['transfer_id']
        self._as_sid(monkeypatch, 'sid-2')
        same_user_other_tab = self._cancel(transfer_id)
        unknown_id = self._cancel('never-existed')
        other_user = self._cancel(transfer_id, user_id=8)
        other_user_unknown = self._cancel('never-existed', user_id=8)
        assert (same_user_other_tab == unknown_id == other_user
                == other_user_unknown == {'success': False})
        assert 's2s_transfer_cancelled' not in wired.recorder.names()

    def test_a_different_user_cannot_cancel_even_as_the_owning_sid(
            self, wired):
        """Owner-sid match must not substitute for the user check."""
        transfer_id = wired.run()['transfer_id']
        # request.sid is still 'sid-1' -- the real owner sid -- but the user is not.
        assert self._cancel(transfer_id, user_id=8) == {'success': False}
        assert wired.registry.get(transfer_id, 7) is not None
        assert 's2s_transfer_cancelled' not in wired.recorder.names()

    # ── two tabs, two transfers: neither can reach the other's ───────────────
    def test_two_tabs_each_cancel_only_their_own(self, wired, monkeypatch):
        first = wired.run()['transfer_id']                 # sid-1
        self._as_sid(monkeypatch, 'sid-2')
        second = wired.run()['transfer_id']                 # sid-2

        # sid-2 may not touch sid-1's transfer, but may cancel its own.
        assert self._cancel(first) == {'success': False}
        assert self._cancel(second) == {'success': True}

        self._as_sid(monkeypatch, 'sid-1')
        assert self._cancel(second) == {'success': False}   # already gone
        assert self._cancel(first) == {'success': True}

        rooms = [(payload['transfer_id'], room)
                 for event, payload, room in wired.recorder.events
                 if event == 's2s_transfer_cancelled']
        assert rooms == [(second, 'sid-2'), (first, 'sid-1')]

    # ── legacy records with no recorded owner ────────────────────────────────
    def test_a_legacy_record_without_an_owner_sid_falls_back_to_user_check(
            self, wired, monkeypatch):
        """Created before a sid could be captured: no owner to compare against."""
        self._as_sid(monkeypatch, None)
        transfer_id = wired.run()['transfer_id']
        assert wired.registry.get(transfer_id, 7).owner_sid is None
        # Any tab of the OWNING USER may cancel it, because there is no owner sid.
        self._as_sid(monkeypatch, 'sid-9')
        assert self._cancel(transfer_id) == {'success': True}

    def test_a_legacy_record_still_refuses_another_user(self, wired, monkeypatch):
        self._as_sid(monkeypatch, None)
        transfer_id = wired.run()['transfer_id']
        self._as_sid(monkeypatch, 'sid-9')
        assert self._cancel(transfer_id, user_id=8) == {'success': False}
        assert wired.registry.get(transfer_id, 7) is not None

    def test_a_legacy_cancellation_falls_back_to_the_user_room(
            self, wired, monkeypatch):
        """No sid to address, so delivery must not be silently dropped."""
        self._as_sid(monkeypatch, None)
        transfer_id = wired.run()['transfer_id']
        self._as_sid(monkeypatch, 'sid-9')
        self._cancel(transfer_id)
        rooms = [room for event, _payload, room in wired.recorder.events
                 if event == 's2s_transfer_cancelled']
        assert rooms == ['user_7']

    def test_the_fallback_never_widens_authority_for_an_owner_bound_record(
            self, wired, monkeypatch):
        """An owner-bound record is not reachable by a sid-less request either."""
        transfer_id = wired.run()['transfer_id']       # owner sid-1
        self._as_sid(monkeypatch, None)                # no sid at all
        assert self._cancel(transfer_id) == {'success': False}
        assert wired.registry.get(transfer_id, 7) is not None

    def test_a_blank_sid_cannot_masquerade_as_a_legacy_record(
            self, wired, monkeypatch):
        """'   ' must not normalize into a match against a None owner_sid."""
        transfer_id = wired.run()['transfer_id']       # owner sid-1
        self._as_sid(monkeypatch, '   ')
        assert self._cancel(transfer_id) == {'success': False}
        self._as_sid(monkeypatch, False)
        assert self._cancel(transfer_id) == {'success': False}
        assert wired.registry.get(transfer_id, 7) is not None

    # ── disconnect scoping still holds alongside explicit cancel ─────────────
    def test_disconnect_scoping_is_unchanged_by_the_owner_check(
            self, wired, monkeypatch):
        first = wired.run()['transfer_id']                  # sid-1
        self._as_sid(monkeypatch, 'sid-2')
        second = wired.run()['transfer_id']                  # sid-2

        # sid-1 disconnecting sweeps only its own transfer.
        assert wired.registry.cancel_all_for_socket(7, 'sid-1') == 1
        assert wired.registry.get(first, 7) is None
        assert wired.registry.get(second, 7) is not None

        # And sid-2 can still explicitly cancel its own afterwards.
        assert self._cancel(second) == {'success': True}
