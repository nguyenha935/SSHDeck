<!--
Thank you for contributing. This template is short on purpose: everything in it
is something a reviewer would otherwise have to ask you for.
-->

> **Base branch:** contributions go to `dev`, not `main`. GitHub offers
> `main` by default — change it in the form above if it still says `main`.
> `main` is only merged into from `dev`, or from the maintainer's own
> release branches. See [CONTRIBUTING.md](../CONTRIBUTING.md#which-branch-to-target).

## What this changes

<!-- One or two sentences. What is different after this PR that was not before? -->

## Why

<!-- The problem, not the patch. If there is an issue, link it: "Fixes #123". -->

## How it was verified

<!--
Say what you actually ran, and paste the result. "Tests pass" is not a
measurement; "1169 passed" is.
-->

- [ ] `pytest tests/ --ignore=tests/integration --ignore=tests/browser -q`
- [ ] `node scripts/run_gates.mjs`
- [ ] Tried it by hand — say on what (browser, phone, Docker)

<!-- If the change touches the shell, the terminal or the auth pages, a before
     and after screenshot saves a reviewer ten minutes. -->

## Checklist

- [ ] The change is focused on one thing
- [ ] New behaviour has a test or a gate that fails without it
- [ ] No debug output, commented-out code or stray whitespace left behind
- [ ] If a file under `static/` or `templates/` changed, its `?v=` pin was
      raised (`tests/test_modal_shell_contract.py` asserts the pins)
- [ ] If a dependency changed, `npm run vendor` was re-run and the result
      committed
- [ ] Commits are signed off (`git commit -s`) — see
      [CONTRIBUTING.md](../CONTRIBUTING.md#sign-your-commits)

## Anything touching credentials, sessions or encryption?

<!--
Say so here even if you are confident. It gets a second pass rather than a
faster merge, and that is the point.
-->
