"""W3: bounded, ordered gap-buffer replay.

What this pins, and which defect each part prevents:

  * the buffer is a GAP-FILLER, not the terminal history. tmux owns history and
    repaints it on reattach, which is why swap_session_transport clears the
    buffer instead of replaying on top of a repaint. Replay therefore keeps the
    NEWEST output and trims the oldest;
  * two independent budgets. 256KB of one enormous line and 256KB of 40k short
    lines cost wildly different amounts to render, so bounding bytes alone still
    let a line-heavy buffer stall the restore;
  * oversized buffer elements are SPLIT, never emitted whole and never dropped:
    one recv() can return far more than a chunk (a large paste, cat of a minified
    file), and emitting it whole would blow the very budget it was meant to obey;
  * truncation is reported. A silent drop leaves the user unable to tell "my
    session started here" from "SSHDeck threw away the top".
"""
import pytest

from app import ssh_manager


@pytest.fixture(autouse=True)
def clean_sessions():
    with ssh_manager.sessions_lock:
        ssh_manager.sessions.clear()
    yield
    with ssh_manager.sessions_lock:
        ssh_manager.sessions.clear()


def _seed_buffer(session_id, elements):
    with ssh_manager.sessions_lock:
        ssh_manager.sessions[session_id] = {
            'client': object(),
            'channel': object(),
            'connected': True,
            'output_buffer': list(elements),
            'output_buffer_size': sum(len(e) for e in elements),
            'output_buffer_max': 512000,
        }


def test_missing_session_replays_nothing():
    chunks, meta = ssh_manager.build_replay_chunks('no-such-session')
    assert chunks == []
    # RULING (S16 B4): history_lines belongs in meta PERMANENTLY, so this
    # contract is updated rather than loosened -- still exact equality, with the
    # new key asserted as 0.
    #
    # Why it belongs here and not out of band: meta is what the caller turns into
    # the wire payload, and every other field in it answers "what did this replay
    # actually contain" (bytes, lines, truncated, dropped_bytes). Whether tmux's
    # own scrollback reached the client is the same kind of question, and it is
    # the ONE number that distinguishes the two outcomes an operator cannot
    # otherwise tell apart: a restore that delivered no history because the pane
    # had none, and a restore that delivered none because the read failed and was
    # swallowed (history is an enrichment, so a failure is deliberately not an
    # error). Carrying it out of band would mean a second return value or a side
    # channel for a fact that is intrinsic to this replay.
    #
    # A missing session has no tmux to read, so the honest answer is 0 -- and the
    # key must still be PRESENT, because a consumer that reads meta['history_lines']
    # must not have to special-case the empty paths.
    assert meta == {'bytes': 0, 'lines': 0, 'truncated': False,
                    'dropped_bytes': 0, 'total_chunks': 0,
                    'history_lines': 0}


def test_meta_carries_exactly_the_contract_keys_on_every_path():
    # The other direction of the same contract: a POPULATED replay's meta has the
    # same key set as an empty one, no more and no less. Asserted as a set so a
    # future field cannot be added silently on one path only -- which is exactly
    # how history_lines could have become present on restores and absent on the
    # empty terminator.
    expected = {'bytes', 'lines', 'truncated', 'dropped_bytes', 'total_chunks',
                'history_lines'}

    _chunks, empty_meta = ssh_manager.build_replay_chunks('no-such-session')
    _seed_buffer('meta-keys-1', [])
    _chunks, blank_meta = ssh_manager.build_replay_chunks('meta-keys-1')
    _seed_buffer('meta-keys-2', ['line one\n', 'line two\n'])
    _chunks, full_meta = ssh_manager.build_replay_chunks('meta-keys-2')

    assert set(empty_meta) == expected
    assert set(blank_meta) == expected
    assert set(full_meta) == expected
    # A non-tmux session (the seed default) asks tmux for nothing, so its history
    # count is 0 while its byte count is not.
    assert full_meta['history_lines'] == 0
    assert full_meta['bytes'] > 0


def test_empty_buffer_replays_nothing_but_is_not_an_error():
    _seed_buffer('empty-1', [])
    chunks, meta = ssh_manager.build_replay_chunks('empty-1')
    assert chunks == []
    assert meta['total_chunks'] == 0
    assert meta['truncated'] is False


def test_small_buffer_is_replayed_whole_and_in_order():
    _seed_buffer('small-1', ['first\r\n', 'second\r\n', 'third\r\n'])
    chunks, meta = ssh_manager.build_replay_chunks('small-1')
    assert ''.join(chunks) == 'first\r\nsecond\r\nthird\r\n'
    assert meta['truncated'] is False
    assert meta['dropped_bytes'] == 0
    assert meta['total_chunks'] == len(chunks) == 1


def test_chunks_are_bounded_by_the_chunk_budget():
    _seed_buffer('chunked-1', ['x' * 100000])
    chunks, meta = ssh_manager.build_replay_chunks(
        'chunked-1', chunk_bytes=32768)
    assert all(len(c) <= 32768 for c in chunks), [len(c) for c in chunks]
    assert meta['total_chunks'] == len(chunks) == 4
    assert ''.join(chunks) == 'x' * 100000


def test_one_oversized_element_is_split_not_emitted_whole():
    """A single recv() can dwarf the chunk budget.

    Emitting it as one chunk would defeat the bound; dropping it would lose the
    output. It must be split.
    """
    _seed_buffer('oversized-1', ['y' * 90000])
    chunks, _meta = ssh_manager.build_replay_chunks(
        'oversized-1', chunk_bytes=8192)
    assert len(chunks) == 11
    assert max(len(c) for c in chunks) == 8192
    # Nothing lost in the split.
    assert ''.join(chunks) == 'y' * 90000


def test_byte_budget_keeps_the_newest_output_and_reports_truncation():
    """The tail is what the user needs; the drop is announced, not silent."""
    payload = ''.join(f'line{i}\n' for i in range(20000))
    _seed_buffer('bytes-1', [payload])
    chunks, meta = ssh_manager.build_replay_chunks(
        'bytes-1', max_bytes=4096, max_lines=100000)
    replayed = ''.join(chunks)
    assert len(replayed) <= 4096
    assert meta['truncated'] is True
    assert meta['dropped_bytes'] == len(payload) - len(replayed)
    # The NEWEST lines survived, the oldest were trimmed.
    assert replayed.endswith('line19999\n')
    assert 'line0\n' not in replayed


def test_line_budget_applies_even_when_the_byte_budget_is_satisfied():
    """The defect a byte-only bound leaves open.

    40k tiny lines are small in bytes but expensive to render, so a byte budget
    alone would happily replay them all and stall the first paint.
    """
    payload = ''.join('a\n' for _ in range(40000))  # 80KB, 40k lines
    _seed_buffer('lines-1', [payload])
    chunks, meta = ssh_manager.build_replay_chunks(
        'lines-1', max_bytes=1048576, max_lines=500)
    replayed = ''.join(chunks)
    assert meta['truncated'] is True
    assert replayed.count('\n') == 500
    assert meta['lines'] == 500
    assert meta['dropped_bytes'] > 0


def test_both_budgets_compose_without_fighting():
    payload = ''.join(f'{"z" * 100}line{i}\n' for i in range(5000))
    _seed_buffer('both-1', [payload])
    chunks, meta = ssh_manager.build_replay_chunks(
        'both-1', max_bytes=20000, max_lines=50, chunk_bytes=4096)
    replayed = ''.join(chunks)
    assert len(replayed) <= 20000
    assert replayed.count('\n') <= 50
    assert meta['truncated'] is True
    # Still the newest content.
    assert replayed.endswith('line4999\n')


def test_replay_filters_device_attribute_responses():
    """A replayed ESC[c would be answered by xterm as if the host just asked."""
    _seed_buffer('da-1', ['before\x1b[?62;c after\r\n'])
    chunks, _meta = ssh_manager.build_replay_chunks('da-1')
    replayed = ''.join(chunks)
    assert '\x1b[?62;c' not in replayed
    assert 'before' in replayed and 'after' in replayed


def test_buffer_exactly_at_the_line_budget_is_not_truncated():
    """The boundary case an off-by-one hides.

    A buffer sitting exactly at the budget is complete; reporting it as
    truncated would print a "we trimmed your history" notice over intact
    history, and trimming it would delete a line that fit.
    """
    payload = ''.join(f'l{i}\n' for i in range(500))
    _seed_buffer('boundary-1', [payload])
    chunks, meta = ssh_manager.build_replay_chunks(
        'boundary-1', max_bytes=1048576, max_lines=500)
    replayed = ''.join(chunks)
    assert meta['truncated'] is False
    assert meta['dropped_bytes'] == 0
    assert replayed == payload
    assert replayed.count('\n') == 500


def test_one_line_over_the_budget_drops_exactly_one_line():
    payload = ''.join(f'l{i}\n' for i in range(501))
    _seed_buffer('boundary-2', [payload])
    chunks, meta = ssh_manager.build_replay_chunks(
        'boundary-2', max_bytes=1048576, max_lines=500)
    replayed = ''.join(chunks)
    assert meta['truncated'] is True
    assert replayed.count('\n') == 500
    # The OLDEST line is the one that went.
    assert not replayed.startswith('l0\n')
    assert replayed.startswith('l1\n')
    assert replayed.endswith('l500\n')


def test_buffer_exactly_at_the_byte_budget_is_not_truncated():
    payload = 'k' * 4096
    _seed_buffer('boundary-3', [payload])
    chunks, meta = ssh_manager.build_replay_chunks(
        'boundary-3', max_bytes=4096, max_lines=100000)
    assert meta['truncated'] is False
    assert ''.join(chunks) == payload


def test_untruncated_replay_reports_no_drop():
    _seed_buffer('exact-1', ['abc\n'])
    _chunks, meta = ssh_manager.build_replay_chunks(
        'exact-1', max_bytes=1000, max_lines=1000)
    assert meta['truncated'] is False
    assert meta['dropped_bytes'] == 0


def test_meta_byte_count_matches_the_chunks_actually_emitted():
    """A meta that disagreed with the payload would make the client's
    sequencing checks meaningless."""
    _seed_buffer('meta-1', ['q' * 70000])
    chunks, meta = ssh_manager.build_replay_chunks('meta-1', chunk_bytes=16384)
    assert meta['bytes'] == len(''.join(chunks))
    assert meta['total_chunks'] == len(chunks)


def test_replay_bounds_defaults_are_tighter_than_the_server_buffer():
    """The replay budget is deliberately smaller than the 512KB buffer.

    Replay competes with the restored terminal's first paint, so it is not
    permitted to spend the whole buffer.
    """
    assert ssh_manager.REPLAY_MAX_BYTES < 512000
    assert ssh_manager.REPLAY_MAX_LINES > 0
    assert ssh_manager.REPLAY_CHUNK_BYTES <= ssh_manager.REPLAY_MAX_BYTES


def test_split_helper_never_drops_content():
    element = 'abcdefghij'
    assert ssh_manager._split_oversized_element(element, 3) == [
        'abc', 'def', 'ghi', 'j']
    assert ''.join(ssh_manager._split_oversized_element(element, 3)) == element


def test_split_helper_handles_a_zero_or_negative_limit():
    """A misconfigured limit must not produce an infinite loop or lose data."""
    assert ssh_manager._split_oversized_element('abc', 0) == ['abc']
    assert ssh_manager._split_oversized_element('abc', -5) == ['abc']
