"""scripts/check_provenance.py: what it refuses, and what it must let through.

The rows that let things through matter as much as the ones that refuse. The
check runs on every push and pull request, and one that tripped on a merge of
a branch named claude/..., on a person's co-author trailer or on a description
that explains the rule would be switched off within a week.
"""
import importlib.util
import json
import os
import subprocess
from pathlib import Path

import pytest

SOURCE = Path(__file__).resolve().parent.parent
_spec = importlib.util.spec_from_file_location(
    'check_provenance', SOURCE / 'scripts' / 'check_provenance.py')
check = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(check)

PERSON = ('Ada Lovelace', 'ada@example.com')
TOOL = ('Claude', 'noreply@anthropic.com')
BOT = ('dependabot[bot]', '49699333+dependabot[bot]@users.noreply.github.com')

# The three forms PR #16 carried, verbatim in shape.
TRAILER = 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
SESSION = 'Claude-Session: https://claude.ai/code/session_01AbCdEf'
LINE = '\U0001F916 Generated with [Claude Code](https://claude.com/claude-code)'


@pytest.fixture
def repo(tmp_path, monkeypatch):
    subprocess.run(['git', 'init', '-q', str(tmp_path)], check=True)
    monkeypatch.chdir(tmp_path)
    return tmp_path


def commit(message, author=PERSON, committer=PERSON):
    env = {**os.environ,
           'GIT_AUTHOR_NAME': author[0], 'GIT_AUTHOR_EMAIL': author[1],
           'GIT_COMMITTER_NAME': committer[0], 'GIT_COMMITTER_EMAIL': committer[1]}
    subprocess.run(['git', '-c', 'commit.gpgsign=false', 'commit', '-q',
                    '--allow-empty', '--no-verify', '-m', message],
                   env=env, check=True)


def found(pr_body=''):
    return list(check.findings(check.commits(['HEAD']), pr_body))


def test_a_persons_commit_passes(repo):
    commit('fix: a thing\n\nSigned-off-by: Ada Lovelace <ada@example.com>')
    assert found() == []


def test_a_tool_as_author_is_refused(repo):
    commit('fix: a thing', author=TOOL)
    result = found()
    assert len(result) == 1 and 'the author is Claude <noreply@anthropic.com>' in result[0]


def test_a_tool_as_committer_is_refused(repo):
    commit('fix: a thing', committer=TOOL)
    result = found()
    assert len(result) == 1 and 'the committer is Claude <noreply@anthropic.com>' in result[0]


@pytest.mark.parametrize('mark, what', [
    (TRAILER, 'an AI co-author trailer'),
    (SESSION, 'a Claude-Session trailer'),
    (LINE, 'the Claude Code attribution line'),
])
def test_each_form_in_a_message_is_refused(repo, mark, what):
    commit(f'fix: a thing\n\n{mark}')
    assert any(what in line for line in found()), found()


def test_the_history_is_read_not_just_the_tip(repo):
    commit(f'fix: first\n\n{TRAILER}')
    commit('fix: second, clean')
    assert len(found()) == 1


@pytest.mark.parametrize('message, author', [
    # PR #16's own merge, which stays on main.
    ('Merge pull request #16 from nguyenha935/claude/youthful-ritchie-uwktak', PERSON),
    # A commit about the rule may name what it refuses.
    ('chore: refuse the co-author trailer and the "generated with" line a tool '
     'adds, and a Claude-Session link', PERSON),
    ('fix: a thing\n\nCo-Authored-By: Grace Hopper <grace@example.com>', PERSON),
    ('deps(python): bump redis', BOT),
])
def test_what_must_pass(repo, message, author):
    commit(message, author=author)
    assert found() == []


def test_the_pull_request_description_is_checked(repo):
    commit('fix: a thing')
    assert found(f'Fixes the resize.\n\n{LINE}') == [
        'the pull request description carries the Claude Code attribution line']
    assert found('Session: https://claude.ai/code/session_01AbCdEf') == [
        'the pull request description carries a claude.ai session link']
    assert found('Keeps tool attribution out, as AGENTS.md section 11 says.') == []


def test_this_repositorys_history_is_clean():
    if not (SOURCE / '.git').exists():
        pytest.skip('not a git checkout')
    history = check.commits(['HEAD'])
    assert history, 'no commits read -- this row would pass vacuously'
    assert list(check.findings(history)) == []


def test_claude_code_is_told_not_to_sign():
    """The first layer: the committed settings every Claude Code session reads."""
    settings = json.loads((SOURCE / '.claude' / 'settings.json').read_text(encoding='utf-8'))
    # Spelled out rather than `"attribution": false`, which Claude Code before
    # v2.1.281 rejects by skipping the WHOLE file.
    assert settings['attribution'] == {'commit': '', 'pr': '', 'sessionUrl': False}


def test_only_the_shared_settings_are_committed():
    if not (SOURCE / '.git').exists():
        pytest.skip('not a git checkout')

    def ignored(rel):
        return subprocess.run(['git', 'check-ignore', '-q', rel],
                              cwd=SOURCE).returncode == 0

    assert not ignored('.claude/settings.json')
    assert ignored('.claude/settings.local.json')
