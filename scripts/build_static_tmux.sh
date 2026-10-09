#!/bin/sh
# Build SSHDeck's static tmux for THIS machine's architecture.
#
# SSHDeck copies the result onto a Linux host that has no tmux, so that a
# session there is still kept when the browser goes away (see
# provision_static_tmux in app/ssh_manager.py). It must run on any Linux of
# that architecture, so it is linked statically against musl, with the
# terminfo entries a browser terminal uses compiled in.
#
# Run it inside the pinned Alpine image, which supplies the toolchain and the
# C library whose licence is recorded below:
#
#   docker run --rm -v "$PWD:/w" -w /w \
#     alpine@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8 \
#     sh scripts/build_static_tmux.sh vendor/tmux
#
# The work directory is fixed because build paths end up in the binary. Two
# builds from the same image and sources were byte-identical (2026-10-08,
# x86_64), and CI rebuilds both architectures and compares them with the
# committed files (.github/workflows/static-tmux.yml).
set -eu

OUT=${1:?usage: build_static_tmux.sh OUTPUT_DIR}
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)

TMUX_V=3.8
TMUX_SHA=e79c699c7e949dccd0a4a125e17b8d1261e311b16979dbc8eb34542f3966d82e
LIBEVENT_V=2.1.13-stable
LIBEVENT_SHA=f7e9383b8c0baa81b687e5b5eecc01beefaf1b19b64151d95ed61647fe7a315c
NCURSES_V=6.5
NCURSES_SHA=136d91bc269a9a5785e5f9e980bc76ab57428f604ce3e5a5a90cebc767971cc6
MUSL_V=1.2.5
MUSL_SHA=a9a118bbe84d8764da0ea0d28b3ab3fae8477fc7e4085d90102b8596fc7c75e4

case "$(uname -m)" in
    x86_64|aarch64) ARCH=$(uname -m) ;;
    *) echo "no static tmux for $(uname -m)" >&2; exit 1 ;;
esac

apk add --no-cache build-base linux-headers bison pkgconf curl \
    ncurses ncurses-terminfo >/dev/null
# The binary carries this musl; its licence below must be the same version's.
apk list -I musl | grep -q "^musl-${MUSL_V}-" || {
    echo "the image's musl is not ${MUSL_V}" >&2; exit 1; }

WORK=/tmp/sshdeck-tmux-build
PREFIX=$WORK/prefix
rm -rf "$WORK"
mkdir -p "$PREFIX"

fetch() {
    curl -fsSLo "$WORK/$1" "$2"
    echo "$3  $WORK/$1" | sha256sum -c - >/dev/null
    tar xzf "$WORK/$1" -C "$WORK"
}
fetch tmux.tgz "https://github.com/tmux/tmux/releases/download/${TMUX_V}/tmux-${TMUX_V}.tar.gz" "$TMUX_SHA"
fetch libevent.tgz "https://github.com/libevent/libevent/releases/download/release-${LIBEVENT_V}/libevent-${LIBEVENT_V}.tar.gz" "$LIBEVENT_SHA"
fetch ncurses.tgz "https://invisible-mirror.net/archives/ncurses/ncurses-${NCURSES_V}.tar.gz" "$NCURSES_SHA"
fetch musl.tgz "https://musl.libc.org/releases/musl-${MUSL_V}.tar.gz" "$MUSL_SHA"

# Compiled-in terminfo: a host with no terminfo database at all still knows
# the terminal the browser presents and the one tmux gives its panes.
cd "$WORK/ncurses-${NCURSES_V}"
./configure --prefix="$PREFIX" --without-shared --with-normal --without-debug \
    --without-ada --without-cxx --without-cxx-binding --without-manpages \
    --without-progs --without-tests --enable-widec --disable-db-install \
    --with-fallbacks=xterm-256color,tmux-256color,screen-256color,screen,xterm,vt100 \
    --with-terminfo-dirs=/etc/terminfo:/lib/terminfo:/usr/share/terminfo:/usr/lib/terminfo \
    --with-default-terminfo-dir=/usr/share/terminfo >/dev/null
make -j2 >/dev/null
make install >/dev/null

cd "$WORK/libevent-${LIBEVENT_V}"
./configure --prefix="$PREFIX" --disable-shared --enable-static \
    --disable-openssl --disable-samples --disable-libevent-regress \
    --disable-debug-mode >/dev/null
make -j2 >/dev/null
make install >/dev/null

cd "$WORK/tmux-${TMUX_V}"
PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig" ./configure --enable-static \
    CFLAGS="-I$PREFIX/include -I$PREFIX/include/ncursesw -O2" \
    LDFLAGS="-L$PREFIX/lib" \
    LIBNCURSES_CFLAGS="-I$PREFIX/include/ncursesw" \
    LIBNCURSES_LIBS="-L$PREFIX/lib -lncursesw" >/dev/null
make -j2 >/dev/null

BINARY="$OUT/tmux-${TMUX_V}-linux-${ARCH}"
strip -o "$BINARY" "$WORK/tmux-${TMUX_V}/tmux"
chmod 755 "$BINARY"
"$BINARY" -V

{
    printf '%s\n' "Licences of the software in SSHDeck's static tmux binaries."
    for entry in \
        "tmux ${TMUX_V}|tmux-${TMUX_V}/COPYING" \
        "libevent ${LIBEVENT_V}|libevent-${LIBEVENT_V}/LICENSE" \
        "ncurses ${NCURSES_V}|ncurses-${NCURSES_V}/COPYING" \
        "musl ${MUSL_V}|musl-${MUSL_V}/COPYRIGHT"; do
        printf '\n==== %s ====\n\n' "${entry%%|*}"
        cat "$WORK/${entry#*|}"
    done
} > "$OUT/LICENSES.txt"
