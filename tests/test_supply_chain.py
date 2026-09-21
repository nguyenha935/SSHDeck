"""What runs in CI, and what asks for a version bump, stays ours.

The dependency configuration on this repository was inherited from upstream
WebSSH and nobody read it: German comments, a Europe/Berlin schedule, and a
`semver-major` filter that did not hold for the one requirement written as a
range. It survived a history squash and several cleanups because nothing ever
looked at it. These rows are that look, run on every commit.

They pin three things a reader cannot see by reading a diff:

  * every `uses:` in a workflow is a commit SHA, not a tag. A tag is a moving
    pointer someone else controls, and the image job holds a token that can
    write packages.
  * every declared Python dependency is pinned. Dependabot's major-version
    filter governs a VERSION update and not a RANGE, so a range is how a major
    arrives unannounced (measured: redis 6.x -> 7.x, then 7.x -> 8.x).
  * the update schedule runs on this project's timezone.
"""
import re
from pathlib import Path

SOURCE = Path(__file__).resolve().parent.parent
WORKFLOWS = sorted((SOURCE / '.github' / 'workflows').glob('*.yml'))
DEPENDABOT = SOURCE / '.github' / 'dependabot.yml'
REQUIREMENTS = SOURCE / 'requirements.txt'

TIMEZONE = 'Asia/Ho_Chi_Minh'
# `uses: owner/repo@<40 hex> # tag`, the form Dependabot itself maintains.
PINNED = re.compile(r'^\s*uses:\s+(?P<action>[\w.-]+/[\w.-]+)@(?P<ref>\S+)(?:\s+#\s*(?P<tag>\S+))?')


def _uses_lines():
    for path in WORKFLOWS:
        for number, line in enumerate(path.read_text(encoding='utf-8').splitlines(), 1):
            if re.match(r'^\s*uses:\s', line):
                yield path.name, number, line


def test_every_workflow_action_is_pinned_to_a_sha():
    assert WORKFLOWS, 'no workflows found -- this test would pass vacuously'
    unpinned = []
    for name, number, line in _uses_lines():
        match = PINNED.match(line)
        if not match or not re.fullmatch(r'[0-9a-f]{40}', match.group('ref')):
            unpinned.append(f'{name}:{number}: {line.strip()}')
    assert not unpinned, (
        'these actions are not pinned to a commit SHA, so whoever owns the tag '
        'decides what runs in CI:\n  ' + '\n  '.join(unpinned))


def test_every_pinned_action_says_which_tag_it_is():
    """The SHA is the contract; the comment is how a human (and Dependabot) reads it."""
    missing = []
    for name, number, line in _uses_lines():
        match = PINNED.match(line)
        if match is None or not match.group('tag'):
            missing.append(f'{name}:{number}: {line.strip()}')
    assert not missing, (
        'pinned without a `# <tag>` comment -- Dependabot needs it to update the '
        'pin, and a reader needs it to know what the SHA is:\n  ' + '\n  '.join(missing))


def test_every_python_requirement_is_pinned():
    """A range is how a major version arrives without the filter noticing."""
    loose = []
    for number, raw in enumerate(REQUIREMENTS.read_text(encoding='utf-8').splitlines(), 1):
        line = raw.split('#', 1)[0].strip()
        if not line:
            continue
        if '==' not in line:
            loose.append(f'requirements.txt:{number}: {line}')
    assert not loose, (
        'not pinned, so Dependabot will offer a major version as a requirement '
        'update, which `ignore: version-update:semver-major` does not cover:\n  '
        + '\n  '.join(loose))


def test_the_update_schedule_runs_on_our_clock():
    # Comments are excluded on purpose: this file EXPLAINS the inherited
    # Europe/Berlin schedule, and a row that read the explanation as
    # configuration would forbid writing down why the configuration changed.
    settings = '\n'.join(
        line for line in DEPENDABOT.read_text(encoding='utf-8').splitlines()
        if not line.lstrip().startswith('#'))
    ecosystems = settings.count('package-ecosystem:')
    assert ecosystems >= 1, 'no ecosystem declared'
    assert settings.count(f'timezone: "{TIMEZONE}"') == ecosystems, (
        f'every ecosystem must declare timezone: "{TIMEZONE}" -- the inherited '
        'file ran on Europe/Berlin and nobody noticed for a day')
    assert 'Europe/Berlin' not in settings
    # The inherited file was written in German; a reader here should not have to
    # guess at the words that decide when a bot files a pull request.
    assert 'Abhängigkeiten' not in settings
