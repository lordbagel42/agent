"""Independent DEBUGSHARE dispatcher. Never imports June or ordinary job policy."""

import fcntl
import hashlib
import json
import os
import re
import stat
import subprocess
import tempfile
import time
from pathlib import Path

UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
THREAD = re.compile(r"T-[0-9a-f-]{36}", re.IGNORECASE)
LIMIT = 64 * 1024 * 1024


def read_private(path, limit=LIMIT, owner=None):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as file:
        info = os.fstat(file.fileno())
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_mode & (0o022 if owner == 0 else 0o077)
            or info.st_uid != (os.getuid() if owner is None else owner)
            or info.st_size > limit
        ):
            raise ValueError("unsafe_debug_file")
        data = file.read(limit + 1)
        if len(data) > limit:
            raise ValueError("debug_file_too_large")
        return data


def sync_directory(directory):
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def private_directory(directory):
    path = Path(directory)
    info = path.lstat()
    if (
        not path.is_absolute()
        or path.resolve() != path
        or not stat.S_ISDIR(info.st_mode)
        or info.st_mode & 0o077
        or info.st_uid != os.getuid()
    ):
        raise ValueError("unsafe_debug_directory")
    return path


def save_receipt(directory, receipt):
    fd, temporary = tempfile.mkstemp(prefix=".receipt-", dir=directory)
    try:
        with os.fdopen(fd, "w") as file:
            json.dump(receipt, file)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, directory / f"{receipt['id']}.receipt.json")
        sync_directory(directory)
    finally:
        Path(temporary).unlink(missing_ok=True)


def dispatch(directory, path, ssh):
    identity = path.stem
    receipt_path = directory / f"{identity}.receipt.json"
    if receipt_path.exists():
        return
    receipt = {"id": identity, "status": "running"}
    # A durable launch intent is the fence. Neither daemon restarts nor a lost
    # transport response can authorize another external launch for this UUID.
    save_receipt(directory, receipt)
    try:
        data = read_private(path)
        if json.loads(data).get("id") != identity:
            raise ValueError("debug_identity_mismatch")
        digest = hashlib.sha256(data).hexdigest()
        # Use a file for stdin, avoiding pipe deadlock for large snapshots.
        with tempfile.TemporaryFile() as incoming:
            incoming.write(data)
            incoming.seek(0)
            with subprocess.Popen(
                [*ssh, f"june-debugshare {identity} {digest}"],
                stdin=incoming,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
            ) as process:
                succeeded = False
                try:
                    while line := process.stdout.readline(1_048_577):
                        if len(line) > 1_048_576:
                            raise ValueError("debug_stream_record_too_large")
                        message = json.loads(line)
                        if not isinstance(message, dict):
                            raise TypeError("invalid_debug_stream")
                        if (
                            message.get("type") == "system"
                            and message.get("subtype") == "init"
                        ):
                            thread = message.get("session_id")
                            if (
                                "threadId" in receipt
                                or not isinstance(thread, str)
                                or not THREAD.fullmatch(thread)
                            ):
                                raise ValueError("invalid_debug_thread")
                            receipt["threadId"] = thread
                            save_receipt(directory, receipt)
                        if message.get("type") == "result":
                            if (
                                not receipt.get("threadId")
                                or message.get("session_id") != receipt["threadId"]
                            ):
                                raise ValueError("invalid_debug_result")
                            succeeded = message.get("is_error") is False
                    receipt["status"] = (
                        "completed" if process.wait() == 0 and succeeded else "unknown"
                    )
                except BaseException:
                    # Only stop our transport, never assume the remote agent stopped.
                    process.kill()
                    process.wait()
                    raise
    except Exception:  # noqa: BLE001 - uncertain effects must retain the launch fence
        receipt["status"] = "unknown"
    save_receipt(directory, receipt)


def main():
    os.umask(0o077)
    config = json.loads(read_private("/etc/june/debugshare.json", owner=0))
    directory = private_directory(config["directory"])
    ssh = config["ssh"]
    if (
        not isinstance(ssh, list)
        or not ssh
        or ssh[0] != "/usr/bin/ssh"
        or any(not isinstance(arg, str) or not arg for arg in ssh)
    ):
        raise ValueError("invalid_debug_ssh")
    # One independent dispatcher; restarting it never replays launch intents.
    with open(directory / ".dispatcher.lock", "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        for path in directory.glob("*.receipt.json"):
            receipt = json.loads(read_private(path, limit=4096))
            if (
                not UUID.fullmatch(receipt["id"])
                or path.name != f"{receipt['id']}.receipt.json"
            ):
                raise ValueError("invalid_debug_receipt")
            if receipt["status"] == "running":
                receipt["status"] = "unknown"
                save_receipt(directory, receipt)
        while True:
            for path in sorted(directory.glob("*.json")):
                if UUID.fullmatch(path.stem):
                    dispatch(directory, path, ssh)
            time.sleep(2)


if __name__ == "__main__":
    try:
        main()
    except Exception:  # noqa: BLE001 - never log private payloads or transport errors
        raise SystemExit("june_debugshare_dispatch_failed") from None
