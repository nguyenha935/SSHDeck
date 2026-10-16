#!/bin/sh
# Start the throwaway SSH target: the run's password for `deck`, fresh host
# keys, sshd in the foreground.
set -eu
: "${DECK_PASSWORD:?the live world passes the account password}"
echo "deck:${DECK_PASSWORD}" | chpasswd
unset DECK_PASSWORD
ssh-keygen -A >/dev/null
exec /usr/sbin/sshd -D -e
