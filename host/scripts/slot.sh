#!/bin/sh
# Root-installed launcher. Node, not a shell/tsx wrapper, remains MainPID:
# the shell opens the runtime lock as FD9 and execs the pinned runtime. It
# does not take the lock; the app acquires that same open file description
# with flock(1) only on private activation, never in standby.
set -eu
# The pinned runtime already bound by the controller, not PATH or an app argument.
NODE=/opt/node-v24.21.0/bin/node
LOCK=/run/june-runtime/owner.lock

reject() {
  echo 'June slot launcher rejected its runtime configuration' >&2
  exit 1
}

[ "$#" -eq 1 ] || reject
case "$1" in blue | green) ;; *) reject ;; esac
# Immutable, canonical release working directory.
root=$(pwd -P) || reject
revision=${root#/opt/june/releases/}
[ "/opt/june/releases/$revision" = "$root" ] && [ "${#revision}" -eq 40 ] || reject
case "$revision" in *[!0-9a-f]*) reject ;; esac
# Pre-provisioned regular lock with one link; never create or follow it.
[ -f "$LOCK" ] && [ ! -L "$LOCK" ] || reject
command exec 9<>"$LOCK" || reject
[ -f /dev/fd/9 ] && [ "$(stat -L -c %h /dev/fd/9)" = 1 ] || reject
JUNE_RUNTIME_LOCK_FD=9
JUNE_SLOT=$1
export JUNE_RUNTIME_LOCK_FD JUNE_SLOT
# Do not permit inherited Node options to inject startup code or a loader.
unset NODE_OPTIONS NODE_PATH
exec "$NODE" --import tsx src/main.ts
