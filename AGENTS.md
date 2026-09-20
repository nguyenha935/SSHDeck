# AGENTS.md — operating rules for AI agents in this repository

**Read this file first, and re-read it after every context compaction.**

Every rule below exists because it was already violated at least once in this
project. None of them are hypothetical. Where a rule has a recurrence count,
that count is real.

---

## 1. The UI specification — the single most important thing in this file

There are exactly **two** files with authority over the user interface:

```
docs/spec/sshdeck-ui-plan-v5.html      (469 lines) — the approved v5 mockup
docs/spec/webssh-plan-amendment-v5.md  (119 lines) — amendment v5
```

**These two files are the ONLY authority on UI.** They are the approved spec.
The mockup governs layout, icons, buttons and behaviour **exactly**.

They live **in the repository** since 2026-09-20. Until then they sat outside
it at `/opt/sshdeck-spec/`, which meant a fresh clone could not satisfy this
section at all -- the rule named files the reader did not have. The amendment
keeps its original filename so that every citation already written in the CSS,
the gates and `docs/DECISIONS.md` still resolves.

> **This has already gone wrong.** An agent searched `docs/` for a mockup, found
> none (they were outside the repo then), reported "no mockup file exists", and
> began reasoning about UI layout from first principles. The user had to correct it. In the user's own words,
> losing the path to the spec "is the single most damaging thing that can happen
> in this session — it is how earlier work drifted into something the user
> rejected outright."

Therefore:

- **Re-read both files after every compact.** Not "check they exist" — read them.
- **Every UI change must cite a mockup or amendment line number.** If you cannot
  cite a line, you are inferring. Say so explicitly and label the inference
  (the established convention is `[INF-n]`) so the user can approve or reject it
  individually.
- If the spec is silent on something, **say it is silent**. Do not present an
  inference as if it were specified. Do look for the nearest governing
  convention in the spec and cite that instead — e.g. the spec never mentions
  toasts, but mockup lines 264–268 anchor every floating surface *below* the row
  that owns it, and amendment line 94 requires the keypad to shrink the terminal
  rather than overlay it. That is a real, citable convention.
- **The mockup wins over both the agent's and the user's preferences.**

---

## 2. Tests prove a minimum, never an appearance

**Any UI change must be verified by rendering a PNG and looking at the image.**
Test counts are not visual verification.

A geometry/floor assertion set — `min-height >= 44px`, "does not overflow",
"still a table" — proves a **lower bound**. It structurally cannot see:

- an element that is too **LARGE** (an unsized `<svg>` painting at its default
  300×150 across the card — missed by **1,470 passing assertions**)
- elements that are **wrongly stacked** (a toast covering the only control that
  leaves the admin page — 147×36px of cover, the link genuinely unclickable,
  while every floor assertion stayed green)
- something that is merely **ugly, bland or unfinished**

> **This has happened four times.** Four separate occasions where a fully green
> suite hid a grossly visible bug. Green is not acceptance. **Eyes are the
> acceptance gate.**

Practical consequences:

- Render the page, `Read` the PNG, and state a verdict per image.
- Do not grade on a curve. If a page is acceptable but bland or unfinished, say
  so plainly.
- When you add an assertion, **also add the companion that guards it.** A
  ceiling needs a floor beside it: `iconCount > 0` next to "no icon exceeds N
  px", or a toast would-be-vacuous check ("a toast really was raised", "the
  toast is inside the viewport") next to "the toast does not overlap".
- **Verify the assertion actually bites**: mutate the fix, confirm the suite goes
  red with the expected count, restore byte-exact, and prove the restore with
  `cmp`. An assertion that passes with the fix removed is not an assertion.
- Beware measuring a **transient** state. `.notification` animates in over
  0.4s; measuring at 300ms reads an off-screen pre-animation rect and every
  overlap check passes vacuously. Let animations settle before asserting.
- Beware measuring the **wrong element**. A `<input>` at 18px inside a
  `<label min-height:44px>` is not a touch-target violation — the label is the
  target. A clipped `thead` (`1×1`, `overflow:hidden`, `clip-path:inset(50%)`)
  has a wide rect that paints nowhere; use `documentElement.scrollWidth` vs
  `clientWidth` to test real horizontal scroll, not raw rects.

---

## 3. The CSS cascade rule

Before adding a class or a rule, read the cascade **low-to-high** and know which
existing declarations compete with yours at equal specificity.

**At equal specificity, source order decides. Therefore:**

> **A corrected BASE rule goes BEFORE the media queries.**
> **A corrected OVERRIDE goes AFTER them.**

> **This trap has recurred four times**, including a second-order case where
> putting the corrected rule *after* the media queries defeated the responsive
> shrink it was supposed to preserve.

Related, and also already encountered: a custom property is substituted against
the element it is **declared** on, not the element it is **used** on. A token
derived from a themed token must be declared at the same level the themes
compete at (`body`, where the `body[data-theme=...]` blocks live), not in
`:root` — otherwise it resolves against `:root` and silently takes one value in
all ten themes.

Mechanical check to run **every time**, in order:

1. `grep` for the property/class across the whole stylesheet — every occurrence.
2. Note which are inside `@media` blocks and at what line.
3. Decide base-vs-override, and place accordingly per the rule above.
4. **Measure the computed value** at each affected viewport and theme.

Step 4 is the one that actually catches it. Steps 1–3 have passed while the bug
was still live. Grepping for the declaration text cannot distinguish "written
correctly" from "resolving in the wrong scope" — only a computed read can.

---

## 4. Colours and themes

- **Zero hardcoded colours.** Theme custom properties only — `var()` or
  `color-mix()` over a theme token. Greys, shadows, overlays and borders
  included.
- **All 10 themes must render on every page.** They are:
  `glass`, `retro`, `solar`, `paper`, `noir`, `arctic-ice`, `rose-gold`,
  `cyberpunk-neon`, `emerald-matrix`, `obsidian`.
- `glass` has **no** `body[data-theme]` block — it **is** `:root`. Counting only
  `body[data-theme]` blocks gives 9 and silently drops a theme.
- Only `paper` is actually a light theme. `solar`, `arctic-ice` and `rose-gold`
  read as light-ish but are dark. Do not assume from the name.
- Amendment **line 109**: every existing theme must keep working; do not
  re-hardcode a theme or change tokens out of scope.
- Some palettes are deliberately degenerate. `obsidian` is
  `--accent-primary: #ffffff` **and** `--text-primary: #ffffff` on `#000000`
  (mockup line 219) — accent equals primary text *by design*. So an affordance
  that relies on colour alone cannot work there. Fix such issues
  **structurally** and theme-agnostically (e.g. `text-decoration: underline`,
  which carries no colour and cannot break a palette), never by hardcoding a
  colour or editing a theme's palette. If no structural fix exists, escalate to
  the user for a theme-level ruling.
- Hover-only affordances do not exist on touch. See §5 — touch is priority #1.

---

## 5. The three non-negotiable priority axes

In this order:

1. **Mobile touch support**
2. **Vietnamese IME input**
3. **Full command streaming**

When a trade-off arises, the higher axis wins. A design that is elegant on
desktop but degrades touch is the wrong design. Concretely: a `:hover`-only
affordance is not an affordance, because the primary target has no hover.

Dead code that causes lag must be removed.

---

## 6. Communication

- **Respond to the user in Vietnamese.** Internal reasoning, code, comments,
  commit messages and test output may be English.
- Report **real numbers**, never rounded into words. "All green" is not a
  report; `2681 passed, 0 failed` is.
- Never present work as finished when it is not. Be blunt about what is broken,
  unverified, or still an un-ruled inference.
- Flag provenance: distinguish what came from the spec files (cite the line)
  from what came from a user message from what is your own inference.
- When you are wrong, say so plainly and correct the record — including in code
  comments that captured the wrong reasoning.

---

## 7. Ask before changing code

**Request approval before editing files and before running commands.** This is a
strictly supervised workflow.

- Never choose an allow-all permission option.
- **Forbidden without explicit, current approval:** commit, push, PR, rebuild,
  deploy, deleting files outside `/tmp`, any state-changing git command
  (including `git stash`), `/compact`, changing the session/model/settings.
- **Read-only git only.** Remotes belong to the user: list them, never touch them.
- The user decides when to deploy. PR only on explicit say-so.
- Before a deploy, read the live registry and say who has a session open. A
  deploy cuts the transport of every open session (the tmux sessions survive,
  their owners must re-attach). A tmux session of the owner's own is NOT
  rubbish; rubbish is a tmux session with no `ssh_sessions` row pointing at it.

> A deployment is recorded by the git log and by the decision log described in
> section 9.

### Test integrity

- **Do not skip or ignore any test.** Do not weaken, remove or force an
  assertion; no force-clicks, no suppressed failures, no increased timing
  constants to make something pass.
- Never modify a test to hide a defect. **Net meaningful coverage must not
  decrease**, and do not pad it with duplicate coverage either.
- Classify every failure as **(a)** the test asserts old, pre-v5 behaviour, or
  **(b)** a real app defect. Report the (a)/(b) counts **before** editing
  anything. For (b), **fix the app** — never the test.
- "Not yet classified" and "not yet diagnosed" are acceptable; leaving a red
  suite without a written (a)/(b) verdict is not.
- Report failures as they are. Do not fit expectations to output.

### Command output must not be masked

Wrap commands so a non-zero exit cannot be swallowed by a later success:

```bash
out=$(<cmd> 2>&1)
ec=$?
printf '%s\n' "$out"
echo "X_RC=$ec"
exit "$ec"
```

Never end with a bare `echo` that becomes the final status, and never pipe test
output through `grep` as the last stage — that reports grep's exit code, not the
test's. Redirect the suite to a log, capture `$?` immediately, then grep the log.
Run each suite **separately** so one failure cannot mask the rest.

### Secrets

Never read or print secret values, `.env` contents (not even through a redacting
filter), container `Env`, auth labels, tokens, cookies, credentials, or identity
files. For container facts use output-whitelisted commands with explicit
non-secret format fields — never a full resolved config, which can leak unknown
keys. Determine variable *names* from `compose.yaml` literals or
`docker compose config --no-interpolate`.

### Probe files

A probe **script** lives INSIDE the tree, next to the gates it borrows from --
`tests/browser/_probe_*.mjs` -- and is deleted the moment it has answered.
Measured 2026-09-18: node cannot resolve `playwright` from `/tmp`, so a probe
parked there fails before it runs, and a copy of a gate additionally needs its
`ROOT` rewritten. What a probe *produces* -- screenshots, logs, captures --
still goes outside the tree, under `/tmp`.

Either way: delete the script afterwards and confirm `git status` is clean.
Never add a probe to staging.

---

## 8. Project identity

SSHDeck is a **standalone project**, not a PR against its historical upstream.
The predecessor backend is **inspiration only**.

The infra cutover is **done** (2026-09-19): the predecessor's container, images,
compose stack, data directory and backups were deleted, and the app runs under
its own name. The project is in its **packaging** phase, so a remaining
predecessor reference is now a defect to clear rather than a deferred item --
clear it when you touch the file, and say so.

Working name rationale is amendment §2 (lines 15–24): `SSH` states the scope,
`Deck` describes collecting and arranging many sessions/panes. Do not change
package, namespace, endpoint or service names during a UI phase (amendment
line 24).

---

## 9. Where the reasoning is written down

`docs/DECISIONS.md` is the running log of decisions and the measurements behind
them. Read it before making a decision that looks novel; it is likely already
ruled on. Add an entry when a decision is made, and cite the spec lines behind
it.

It is **not part of the published tree** (see `.gitignore`): it belongs to the
deployment it was written in, and it names that deployment. A working checkout
has it; a fresh clone does not. The same applies to the operational runbook,
the deploy and rollback scripts, the live gates and the one-off probes.

---

## 10. Deploying and testing

Two suites, both run from the repository root:

```bash
python -m pytest tests --ignore=tests/integration --ignore=tests/browser -q
node scripts/run_gates.mjs                 # every browser gate, 4 workers
node tests/browser/<one gate>.mjs          # one gate on its own
```

`run_gates.mjs` re-runs a red gate on its own before reporting it and says so
when it passes alone -- that is a flaky gate, not a regression.

Releasing is the Docker image described in README.md. A deployment may carry
its own deploy and rollback scripts; those belong to that deployment and are
not published (section 9).

Run the full pytest suite before every deploy: the `?v=` pins of the static
files are asserted in `tests/test_modal_shell_contract.py` and
`tests/test_profile_launcher_ui.py`, and a stale pin is invisible until a
reader gets a cached file.
