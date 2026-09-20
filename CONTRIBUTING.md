# Contributing to SSHDeck

Thanks for your interest in contributing! This project is open to contributions of all kinds - bug reports, feature requests, documentation improvements, and code.

## Quick Links

- [Issues](https://github.com/nguyenha935/SSHDeck/issues) - bugs and feature requests
- [Security issues](SECURITY.md) - report these privately, never as a public issue
- [Commercial licensing](COMMERCIAL.md) - if you want to use SSHDeck commercially

## Getting Started

### Prerequisites

- Python 3.11+
- Docker (optional, for testing)

### Local Development Setup

```bash
# After obtaining the standalone SSHDeck source checkout:
cd sshdeck

# Create virtual environment
python -m venv venv
source venv/bin/activate  # Linux/macOS
# or: venv\Scripts\activate  # Windows

# Install dependencies
pip install -r requirements.txt

# Set required environment variable
export SECRET_KEY=$(openssl rand -hex 32)
export DEBUG=True

# Run the application
python start.py
```

Open http://localhost:5000 and create a test account.

### Project Structure

```
sshdeck/
├── app/                    # Flask application (30 modules)
│   ├── __init__.py        # App factory, routes, security headers
│   ├── auth.py            # Authentication, rate limiting
│   ├── models.py          # SQLAlchemy models
│   ├── socket_events.py   # WebSocket event handlers
│   ├── ssh_manager.py     # SSH connection management
│   ├── sftp_handler.py    # SFTP file operations
│   ├── connection_pool.py # SSH connection pooling
│   ├── key_manager.py     # SSH key storage
│   ├── key_encryption.py  # SSH key encryption at rest
│   ├── profile_manager.py # Connection profiles
│   ├── command_manager.py # Command library
│   ├── binary_transfer.py # Binary file transfer protocol
│   ├── user_settings.py   # User preferences
│   ├── audit_logger.py    # Security audit logging
│   ├── tailscale_ssh.py   # Shared-identity Tailscale SSH
│   ├── tmux_control.py    # tmux helpers for the per-socket views
│   ├── transfer_registry.py # Server-to-server transfer bookkeeping
│   ├── app_settings.py    # Admin-editable runtime limits
│   └── decorators.py      # Shared decorators (and 10 more)
├── static/
│   ├── css/               # Stylesheets (7 files)
│   ├── js/                # Frontend JavaScript (21 modules + 6 locales)
│   └── vendor/            # Vendored xterm and highlight.js (npm run vendor)
├── templates/             # Jinja2 templates (7 files)
├── tests/                 # 72 pytest files + 112 browser gates
├── docs/spec/             # The approved UI specification
├── scripts/               # run_gates.mjs (browser gates), vendor.js (npm assets)
├── config.py              # Central configuration
├── start.py               # Entry point
└── requirements.txt       # Python dependencies
```

## How to Contribute

### Reporting Bugs

Before opening an issue:
1. Check if the issue already exists
2. Try the latest version
3. Collect relevant info (browser, OS, error messages, logs)

Include in your bug report:
- What you expected to happen
- What actually happened
- Steps to reproduce
- Environment details (browser, OS, Docker version if applicable)

### Suggesting Features

Feature requests are welcome! Please include:
- Clear description of the feature
- Use case - why is this useful?
- Possible implementation approach (optional)

### Pull Requests

#### Before You Start

1. **Check existing issues/PRs** - Someone might already be working on it
2. **Open an issue first** for larger changes - Let's discuss the approach
3. **Small PRs are better** - Easier to review and merge

#### Which branch to target

The repository keeps two long-lived branches, and they do different jobs:

| Branch | What it is |
| --- | --- |
| `main` | What a release is cut from: tagged, and the published image is built from it. Meant to be the state the project stands behind. |
| `dev` | Where work lands first, and where it is squared with other work before any of it reaches `main`. |

**Open your pull request against `dev`.** GitHub will offer you `main`
because that is the repository's default branch -- change the base to `dev`
in the pull request form. If you forget, a bot will say so on the pull
request and the maintainer can retarget it; nothing is lost either way.

The maintainer's own work follows the same route for the same reason: a
local branch, then a pull request, so the suites run on it before it is
merged. Nothing is pushed straight to a long-lived branch.

#### Development workflow

1. Fork the repository
2. Create a branch from `dev`
   ```bash
   git switch dev && git pull
   git switch -c feature/your-feature-name
   ```
3. Make your changes
4. Run both suites locally (see below) -- CI runs them on every pull request
5. Commit with clear messages, signed off (`git commit -s`)
6. Push to your fork
7. Open a pull request **against `dev`**

#### Code Style

**Python:**
- Follow PEP 8
- Use meaningful variable names
- Keep functions focused and small
- Lean code: no unnecessary comments, docstrings only where logic is non-obvious

**JavaScript:**
- Vanilla JS only (no frameworks - intentional architecture decision)
- Use consistent indentation (4 spaces)
- Prefer `const` over `let`, avoid `var`

**General:**
- No trailing whitespace
- Files end with a newline
- Keep lines under 100 characters when reasonable

#### Commit Messages

Write clear commit messages:

```
Add SFTP directory creation support

- Implement mkdir operation in sftp_handler.py
- Add socket event handler for create_directory
- Update file manager UI with create folder button

Fixes #42
```

Format:
- First line: Brief summary (imperative mood, max 50 chars)
- Blank line
- Body: Explain what and why (wrap at 72 chars)
- Reference issues if applicable

#### Security Considerations

This project handles SSH credentials. When contributing, please:

- Never log passwords or private keys
- Validate and sanitize all user input
- Check session ownership before operations
- Use parameterized queries (SQLAlchemy handles this)
- Do not keep credentials in long-lived objects; drop the reference as soon
  as the connection attempt is over. (Python cannot guarantee the bytes are
  erased -- SECURITY.md says so plainly, and so should you.)
- Consider path traversal in file operations

If your change touches authentication, encryption, or session handling, please note this in your PR for extra review attention.

#### Testing your changes

Two suites, both of which CI runs on every pull request. Run them before you
open one -- a red CI run is slower for both of us than a local red run.

```bash
# Python: 1180 tests. tests/integration needs a real sshd and skips without one.
pytest tests/ --ignore=tests/integration --ignore=tests/browser -q

# Browser gates: 99 headless gates across Chromium and WebKit, ~5 minutes.
npm ci
npx playwright install chromium webkit
node scripts/run_gates.mjs

# One gate on its own, while you work on it:
node tests/browser/<name>.mjs
```

`run_gates.mjs` re-runs a red gate by itself before reporting it and says
`XANH KHI CHẠY RIÊNG` when it then passes -- that is a flaky gate, not your
regression. Two are known to do this: `viewport_scroll_authority` and
`p1_tmux_vertical_gesture`.

**New behaviour needs a test that fails without it.** For the backend that is a
pytest file; for anything the user can see, a gate in `tests/browser/`. Copy the
shape of an existing one: they render the real templates and stub the socket, so
they need no server and no account.

Beyond the suites:

1. **Test edge cases** - empty inputs, special characters, large files
2. **Check a second browser** - the gates cover Chromium and WebKit; Firefox is
   not covered and is worth a look by hand
3. **Test with Docker** - the container is how most people run it
   ```bash
   docker build -t sshdeck:test .
   docker run -p 5000:5000 -e SECRET_KEY=$(openssl rand -hex 32) \
     -e CORS_ORIGINS=http://localhost:5000 sshdeck:test
   ```

### Documentation

Documentation improvements are always welcome:
- Fix typos or unclear explanations
- Add examples
- Improve README
- Add inline code comments

## Running the live gates

Most gates drive a stubbed page and need nothing but `npm install`. A few --
the ones named `live_*`, `two_device_live` and `typing_order_live` -- drive a
REAL running SSHDeck against a REAL SSH target, so they need to be told where
those are:

```bash
cp tests/live.env.example tests/live.env    # then fill it in
node scripts/run_gates.mjs --live           # every gate, live ones included
node tests/browser/live_e2e_v5.mjs          # or one of them
```

`tests/live.env` is ignored by git. The same names work as environment
variables, and `LIVE_CREDS_FILE` points at the file when you keep it outside
the checkout. Use a throwaway SSHDeck account and a host you own: these gates
open and close sessions, type into shells and move files.

## What's Needed

Areas where contributions are especially welcome:

- [ ] Internationalization (new language translations)
- [ ] Accessibility improvements
- [ ] Performance optimizations
- [ ] Additional themes
- [ ] Documentation
- [ ] More live-gate coverage (the live suite needs a real host, so it runs
      on a maintainer's machine rather than in CI)

## Code of Conduct

Be respectful and constructive. We're all here to build something useful.

- Be welcoming to newcomers
- Accept constructive criticism gracefully
- Focus on what's best for the project
- Show empathy towards others

## Questions?

Open an issue. If it is about using SSHDeck commercially, see
[COMMERCIAL.md](COMMERCIAL.md) instead.

## Sign your commits

Every commit must carry a `Signed-off-by` line, which `git commit -s` adds for
you:

```
Signed-off-by: Your Name <your.email@example.com>
```

It is the [Developer Certificate of Origin](https://developercertificate.org/):
by adding it you state that you wrote the change, or have the right to submit
it, and that you are willing for it to be distributed under this project's
licence. Use your real name and an address that reaches you.

This is not paperwork for its own sake. SSHDeck is licensed, not public domain,
and a project that licenses its own code has to be able to say where every line
came from.

## License

SSHDeck is distributed under the
[PolyForm Noncommercial License 1.0.0](LICENSE), and the maintainer also offers
it commercially (see [COMMERCIAL.md](COMMERCIAL.md)).

By contributing, you agree that:

- your contribution is licensed under the PolyForm Noncommercial License 1.0.0
  along with the rest of the project; and
- you grant the maintainer a perpetual, worldwide, irrevocable right to license
  your contribution under other terms as part of SSHDeck, including the
  commercial licence above.

You keep the copyright in what you wrote. The second point is what makes the
commercial licence possible at all -- without it, a single contributed line
would make the whole project impossible to license commercially. If you are not
comfortable with it, say so in the pull request before it is reviewed rather
than after.
