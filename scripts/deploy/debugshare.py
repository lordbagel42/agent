"""Independent DEBUGSHARE/owner-task dispatcher. Never imports June or job policy."""

import fcntl
import hashlib
import json
import os
import re
import select
import stat
import subprocess
import tempfile
import threading
import time
from pathlib import Path

UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
THREAD = re.compile(r"T-[0-9a-f-]{36}", re.IGNORECASE)
LIMIT = 64 * 1024 * 1024
READY_TIMEOUT = 30


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


def dispatch_due(directory, identity):
    try:
        receipt = json.loads(
            read_private(directory / f"{identity}.receipt.json", limit=65536)
        )
    except FileNotFoundError:
        return True
    if receipt["id"] != identity:
        raise ValueError("invalid_debug_receipt")
    return receipt["status"] == "queued" and receipt["retryAt"] <= time.time() * 1000


def wait_ready(stream, expected):
    # A partial line must not defeat the deadline. Read no bytes beyond READY;
    # the buffered stream reader below owns subsequent Amp records.
    deadline = time.monotonic() + READY_TIMEOUT
    received = b""
    while len(received) < len(expected):
        remaining = deadline - time.monotonic()
        if remaining <= 0 or not select.select([stream], [], [], remaining)[0]:
            raise TimeoutError("debug_runner_not_ready")
        chunk = os.read(stream.fileno(), len(expected) - len(received))
        received += chunk
        if not chunk or not expected.startswith(received):
            raise ValueError("invalid_debug_readiness")


def dispatch(directory, path, ssh):
    identity = path.stem.removesuffix(".task")
    if not dispatch_due(directory, identity):
        return
    receipt = {
        "id": identity,
        "status": "queued",
        "retryAt": int(time.time() * 1000) + 30000,
    }
    # Queued means no snapshot bytes have been authorized for transport. This
    # retry checkpoint survives dispatcher restarts and does not consume admission.
    save_receipt(directory, receipt)
    try:
        data = read_private(path)
        payload = json.loads(data)
        if payload.get("id") != identity:
            raise ValueError("debug_identity_mismatch")
        if payload.get("kind") not in (None, "amp-task"):
            raise ValueError("invalid_dispatch_kind")
        task = payload.get("kind") == "amp-task"
        if task != path.name.endswith(".task.json"):
            raise ValueError("invalid_dispatch_path")
        digest = hashlib.sha256(data).hexdigest()
        # Distinct wire command fails closed against an older diagnostic endpoint.
        command = (
            f"june-{'amp-task' if task else 'debugshare'}-ready {identity} {digest}"
        )
        with subprocess.Popen(
            [*ssh, command],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
        ) as process:
            try:
                wait_ready(process.stdout, f"{command}\n".encode())
                # Never send even buffered bytes before this durable fence. A
                # crash after it is ambiguous, even if Amp emits no thread ID.
                receipt = {"id": identity, "status": "running"}
                save_receipt(directory, receipt)
                # The endpoint consumes all input before starting Amp, so large
                # snapshots cannot deadlock against Amp's stdout stream.
                process.stdin.write(data)
                process.stdin.close()
                succeeded = False
                result = None
                resolved = False
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
                        # Completion alone is not a fix. Retain only the explicit
                        # UUID-bound attestation, never diagnostic report text.
                        resolved = (
                            not task
                            and succeeded
                            and isinstance(message.get("result"), str)
                            and message["result"].rstrip().split("\n")[-1]
                            == f"DEBUGSHARE {identity} RESOLVED"
                        )
                        if (
                            task
                            and succeeded
                            and isinstance(message.get("result"), str)
                        ):
                            encoded = message["result"].encode("utf-8")
                            result = {
                                "text": encoded[:8000].decode("utf-8", errors="ignore"),
                                "truncated": len(encoded) > 8000,
                            }
                receipt["status"] = (
                    "completed" if process.wait() == 0 and succeeded else "unknown"
                )
                if receipt["status"] == "completed" and result is not None:
                    receipt["result"] = result
                if receipt["status"] == "completed" and resolved:
                    receipt["resolved"] = True
            except BaseException:
                # Only stop our transport, never assume the remote agent stopped.
                process.kill()
                process.wait()
                raise
    except Exception:  # noqa: BLE001 - no transport errors or private payloads in receipts
        if receipt["status"] != "queued":
            receipt["status"] = "unknown"
        else:
            receipt["retryAt"] = int(time.time() * 1000) + 30000
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
    # One independent dispatcher; queued retries resume, launch intents never replay.
    with open(directory / ".dispatcher.lock", "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        for path in directory.glob("*.receipt.json"):
            receipt = json.loads(read_private(path, limit=65536))
            if (
                not UUID.fullmatch(receipt["id"])
                or path.name != f"{receipt['id']}.receipt.json"
            ):
                raise ValueError("invalid_debug_receipt")
            if receipt["status"] == "running":
                receipt["status"] = "unknown"
                save_receipt(directory, receipt)
        workers = {}
        while True:
            workers = {
                identity: worker
                for identity, worker in workers.items()
                if worker.is_alive()
            }
            for path in sorted(directory.glob("*.json")):
                identity = path.stem.removesuffix(".task")
                if (
                    UUID.fullmatch(identity)
                    and identity not in workers
                    and dispatch_due(directory, identity)
                ):
                    # One observer per UUID, not one investigation at a time.
                    # Track the worker before the next scan, even if it has not
                    # persisted its launch fence yet. The daemon lock excludes
                    # other dispatchers; durable receipts exclude later replay.
                    worker = threading.Thread(
                        target=dispatch, args=(directory, path, ssh), daemon=True
                    )
                    worker.start()
                    workers[identity] = worker
            time.sleep(2)


if __name__ == "__main__":
    try:
        main()
    except Exception:  # noqa: BLE001 - never log private payloads or transport errors
        raise SystemExit("june_debugshare_dispatch_failed") from None
