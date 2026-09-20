"""Keystrokes reach the pane in the order they were typed.

Every keystroke is its own `ssh_input` event and every event handler runs in
its own greenlet, with DB work before the write. Measured live: `for i in`
reached the shell as `fio irn` at 40 ms per key and as `ofr i in` at 150 ms per
key. The fix is a per-socket ticket taken at the handler's first statement;
these tests pin the ticket primitives with real threads, where a blocked
`begin_input_turn` is unmistakable.
"""
import threading
import time

from app import ssh_manager


def _turn_taker(sid, order, label):
    """Runs in a thread: take a turn, record it, end it."""
    def run():
        ticket = ssh_manager.begin_input_turn(sid)
        order.append((label, ticket))
        ssh_manager.end_input_turn(sid, ticket)
    return threading.Thread(target=run, daemon=True)


def test_a_later_ticket_waits_for_the_earlier_one_to_end():
    sid = 'sock-order-1'
    ssh_manager.forget_input_turns(sid)
    first = ssh_manager.begin_input_turn(sid)
    assert first == 0

    order = []
    second = _turn_taker(sid, order, 'second')
    second.start()
    time.sleep(0.15)
    assert order == [], "the second ticket ran before the first ended"

    ssh_manager.end_input_turn(sid, first)
    second.join(timeout=2)
    assert order == [('second', 1)]


def test_tickets_are_served_in_the_order_they_were_taken():
    sid = 'sock-order-2'
    ssh_manager.forget_input_turns(sid)
    gate = ssh_manager.begin_input_turn(sid)
    order = []
    threads = []
    for label in ('b', 'c', 'd', 'e'):
        t = _turn_taker(sid, order, label)
        t.start()
        time.sleep(0.02)
        threads.append(t)
    ssh_manager.end_input_turn(sid, gate)
    for t in threads:
        t.join(timeout=2)
    assert order == [('b', 1), ('c', 2), ('d', 3), ('e', 4)]


def test_a_stuck_predecessor_delays_a_successor_only_until_the_timeout(monkeypatch):
    monkeypatch.setattr(ssh_manager, 'INPUT_TURN_TIMEOUT_S', 0.2)
    sid = 'sock-order-3'
    ssh_manager.forget_input_turns(sid)
    stuck = ssh_manager.begin_input_turn(sid)

    started = time.monotonic()
    second = ssh_manager.begin_input_turn(sid)
    waited = time.monotonic() - started
    assert second == 1
    assert 0.15 <= waited < 1.0, waited

    # The successor that ran ahead ends normally and serving moves past BOTH;
    # the stuck ticket ending late changes nothing, and the next ticket is
    # served at once.
    ssh_manager.end_input_turn(sid, second)
    ssh_manager.end_input_turn(sid, stuck)
    started = time.monotonic()
    third = ssh_manager.begin_input_turn(sid)
    assert third == 2
    assert time.monotonic() - started < 0.05
    ssh_manager.end_input_turn(sid, third)


def test_sockets_do_not_delay_each_other():
    ssh_manager.forget_input_turns('sock-a')
    ssh_manager.forget_input_turns('sock-b')
    held = ssh_manager.begin_input_turn('sock-a')
    started = time.monotonic()
    other = ssh_manager.begin_input_turn('sock-b')
    assert other == 0
    assert time.monotonic() - started < 0.05
    ssh_manager.end_input_turn('sock-b', other)
    ssh_manager.end_input_turn('sock-a', held)


def test_forgetting_a_socket_starts_it_over():
    sid = 'sock-order-4'
    ssh_manager.forget_input_turns(sid)
    t = ssh_manager.begin_input_turn(sid)
    ssh_manager.end_input_turn(sid, t)
    assert ssh_manager.begin_input_turn(sid) == 1
    ssh_manager.forget_input_turns(sid)
    assert ssh_manager.begin_input_turn(sid) == 0
    ssh_manager.end_input_turn(sid, 0)
    # Ending a ticket of a forgotten socket is harmless.
    ssh_manager.forget_input_turns(sid)
    ssh_manager.end_input_turn(sid, 0)
