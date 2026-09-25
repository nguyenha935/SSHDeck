#!/usr/bin/env python3
"""Refuse history, or a pull request, that carries an AI tool's signature.

SSHDeck is licensed by its author, and CONTRIBUTING.md asks every commit to
say who stands behind it. A tool's co-author trailer, session link or
attribution line says something else. On 2026-09-24 three commits reached main
carrying all three (PR #16, rewritten on 2026-09-25): the rule existed only in
notes outside the repository, so the session that broke it could not have
read it. This is the part of the rule a machine can check; AGENTS.md section
11 is the rest.

Usage:
    scripts/check_provenance.py [REV...]     every commit reachable from REV
                                             (default HEAD)
    PR_BODY=... scripts/check_provenance.py  the description is checked too

It looks for the FORMS these tools write, not for words: a commit or a
description can still talk about the rule, name the tools, or merge a branch
whose name starts with one of them.
"""
import os
import re
import subprocess
import sys

# The address a tool commits under. A person's address is never refused.
TOOL_ADDRESS = re.compile(r'<noreply@anthropic\.com>', re.IGNORECASE)

MARKS = (
    (re.compile(r'^co-authored-by:[^\n]*\b(claude|anthropic|openai|codex|copilot|gemini)\b',
                re.IGNORECASE | re.MULTILINE), 'an AI co-author trailer'),
    (re.compile(r'^claude-session:', re.IGNORECASE | re.MULTILINE),
     'a Claude-Session trailer'),
    (re.compile(r'generated with \[claude code\]\(', re.IGNORECASE),
     'the Claude Code attribution line'),
    (re.compile(r'claude\.ai/code/session_', re.IGNORECASE),
     'a claude.ai session link'),
)

FIELD, RECORD = '\x1f', '\x1e'


def commits(revs):
    out = subprocess.run(
        ['git', 'log', f'--format=%H{FIELD}%an <%ae>{FIELD}%cn <%ce>{FIELD}%B{RECORD}',
         *revs, '--'],
        capture_output=True, text=True, check=True).stdout
    return [record.strip('\n').split(FIELD, 3)
            for record in out.split(RECORD) if record.strip('\n')]


def marks_in(text):
    return [what for pattern, what in MARKS if pattern.search(text)]


def findings(history, pr_body=''):
    for sha, author, committer, message in history:
        for role, who in (('author', author), ('committer', committer)):
            if TOOL_ADDRESS.search(who):
                yield f'{sha[:12]}: the {role} is {who}'
        for what in marks_in(message):
            yield f'{sha[:12]}: the message carries {what}'
    for what in marks_in(pr_body):
        yield f'the pull request description carries {what}'


def main(argv):
    history = commits(argv or ['HEAD'])
    found = list(findings(history, os.environ.get('PR_BODY', '')))
    if found:
        print('AI attribution found (AGENTS.md section 11):')
        print('\n'.join(f'  {line}' for line in found))
        return 1
    print(f'no AI attribution in {len(history)} commit(s)'
          + (' or the pull request description' if os.environ.get('PR_BODY') else ''))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
