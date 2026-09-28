"""Root-installed launcher. Node, not a shell/tsx wrapper, remains MainPID."""

import os
import re
import stat
import sys
from pathlib import Path

# The pinned runtime already bound by deploy.py, not PATH or an app argument.
NODE = "/opt/node-v24.21.0/bin/node"
LOCK = "/run/june-runtime/owner.lock"


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in ("blue", "green"):
        raise ValueError("Expected exactly one fixed slot")
    root = Path.cwd()
    if not re.fullmatch(r"/opt/june/releases/[a-f0-9]{40}", str(root)):
        raise ValueError("Expected immutable release working directory")
    if root.resolve() != root:
        raise ValueError("Release directory must be canonical")
    fd = os.open(LOCK, os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC)
    metadata = os.fstat(fd)
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
        raise ValueError("Expected pre-provisioned regular runtime lock")
    if fd != 9:
        os.dup2(fd, 9, inheritable=True)
        os.close(fd)
    else:
        os.set_inheritable(9, True)
    environment = dict(os.environ)
    environment["JUNE_RUNTIME_LOCK_FD"] = "9"
    environment["JUNE_SLOT"] = sys.argv[1]
    # Do not permit inherited Node options to inject startup code or a loader.
    environment.pop("NODE_OPTIONS", None)
    environment.pop("NODE_PATH", None)
    os.execve(NODE, [NODE, "--import", "tsx", "src/main.ts"], environment)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError):
        sys.exit("June slot launcher rejected its runtime configuration")
