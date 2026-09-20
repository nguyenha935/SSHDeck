# Third-party notices

SSHDeck itself is licensed under the PolyForm Noncommercial License 1.0.0
(see [LICENSE](LICENSE)). Everything listed here belongs to someone else and
keeps its own terms. **SSHDeck's licence does not restrict your rights in any
of it.**

## The project SSHDeck derives from

SSHDeck began from [WebSSH](https://github.com/bifrost0x/webssh) by H31mdall
and still contains work from it. That work is under the MIT License, kept
verbatim in [UPSTREAM-MIT-LICENSE.txt](UPSTREAM-MIT-LICENSE.txt) and reproduced
here:

```
MIT License

Copyright (c) 2026 H31mdall

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

The MIT License remains in force for those portions. It permits sublicensing,
which is what allows the combined work to be distributed under different terms;
it does not let anyone narrow your rights in the original project, which stays
available under MIT from its own repository.

## Browser libraries shipped in `static/vendor/`

These are copied unmodified from their published packages and served by the
application. Each directory carries the full licence text of the packages whose
files it holds.

| Library | Version | Licence | Notice |
| --- | --- | --- | --- |
| xterm.js | 6.0.0 | MIT | [`static/vendor/xterm/LICENSE`](static/vendor/xterm/LICENSE) |
| @xterm/addon-fit | 0.11.0 | MIT | same file |
| @xterm/addon-search | 0.16.0 | MIT | same file |
| @xterm/addon-unicode11 | 0.9.0 | MIT | same file |
| highlight.js (cdn-assets) | 11.11.1 | BSD-3-Clause | [`static/vendor/highlight/LICENSE`](static/vendor/highlight/LICENSE) |
| socket.io-client | 4.8.3 | MIT | [`static/vendor/socketio/LICENSE`](static/vendor/socketio/LICENSE) |
| material-icons | 1.13.14 | Apache-2.0 | [`static/vendor/material-icons/LICENSE`](static/vendor/material-icons/LICENSE) |

`scripts/vendor.js` copies each licence next to the files it covers, so
re-vendoring a library cannot drop its notice again.

## Python packages

Installed from PyPI at the versions pinned in `requirements.txt`, unmodified.
The Docker image contains them, and each carries its own licence metadata in
`site-packages`.

| `Flask` | BSD-3-Clause |
| `Werkzeug` | BSD-3-Clause |
| `Flask-SocketIO` | MIT |
| `python-socketio` | MIT |
| `Flask-Login` | MIT |
| `Flask-SQLAlchemy` | BSD-3-Clause |
| `Flask-WTF` | BSD-3-Clause |
| `paramiko` | LGPL-2.1 |
| `cryptography` | Apache-2.0 OR BSD-3-Clause |
| `bcrypt` | Apache-2.0 |
| `python-dotenv` | BSD-3-Clause |
| `gunicorn` | MIT |
| `eventlet` | MIT |
| `dnspython` | ISC |
| `redis` | MIT |

### Paramiko and the LGPL

Paramiko is the one dependency under a copyleft licence, **LGPL-2.1**.

SSHDeck imports Paramiko as a normal Python package. It does not modify
Paramiko, does not vendor a copy into this repository, and does not link it
statically. The Docker image installs it from PyPI at the pinned version, with
its own licence file alongside it in `site-packages`.

**You may replace it.** Nothing in SSHDeck's licence prevents you from
installing a different build or version of Paramiko in any SSHDeck
installation, or from modifying it -- that is a right the LGPL gives you, and
it is preserved here. Paramiko's source is at
<https://github.com/paramiko/paramiko>.

## Fonts and icons

The Material Icons font files under `static/vendor/material-icons/` are under
Apache-2.0, as recorded in that directory's `LICENSE`. The SSHDeck brand marks
under `static/icons/brand-*` are the licensor's own work and are covered by
[LICENSE](LICENSE); the remaining sprite glyphs are documented in
[`static/icons/LICENSE`](static/icons/LICENSE).
