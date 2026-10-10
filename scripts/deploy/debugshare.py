"""Independent DEBUGSHARE/owner-task dispatcher. Never imports June or job policy."""

import fcntl
import hashlib
import importlib.util
import json
import os
import re
import select
import stat
import subprocess
import tempfile
import threading
import time
from contextlib import ExitStack, suppress
from pathlib import Path

UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
THREAD = re.compile(r"T-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}")
LIMIT = 64 * 1024 * 1024
READY_TIMEOUT = 30
MAX_ACTIVE = 2
MAX_STARTS_PER_HOUR = 4
launch_lock = threading.Lock()


def request_identity(path):
    for suffix in (".task.json", ".incident.json", ".json"):
        if path.name.endswith(suffix):
            return path.name.removesuffix(suffix)
    return ""


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


def save_receipt(directory, receipt, suffix="receipt"):
    fd, temporary = tempfile.mkstemp(prefix=".receipt-", dir=directory)
    try:
        with os.fdopen(fd, "w") as file:
            json.dump(receipt, file)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, directory / f"{receipt['id']}.{suffix}.json")
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


def launch_capacity(directory):
    """Uncertain launches retain capacity until an operator reconciles them."""
    active = 0
    recent = 0
    cutoff = int(time.time() * 1000) - 3_600_000
    for path in directory.glob("*.receipt.json"):
        receipt = json.loads(read_private(path, limit=65536))
        if receipt["status"] in ("running", "unknown"):
            active += 1
    for path in directory.glob("*.launch.json"):
        launch = json.loads(read_private(path, limit=65536))
        if launch["launchedAt"] > cutoff:
            recent += 1
    return active < MAX_ACTIVE and recent < MAX_STARTS_PER_HOUR


def operations_reporter(config):
    if config is None:
        return None
    try:
        # Isolated installed scripts cannot use bare sibling imports.
        spec = importlib.util.spec_from_file_location(
            "operations", Path(__file__).with_name("operations.py")
        )
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        reporter = module.Reporter(config)
        reporter.start()
        return reporter
    except Exception:  # noqa: BLE001 - never report config/path/credential contents
        with suppress(OSError):
            print("operations_disabled: coverage_incomplete", flush=True)
        return None


def observe_dispatch(
    reporter, path, receipt, *, phase, backfill=False, attempt=False, payload=None
):
    if reporter is None:
        return
    try:
        if payload is None:
            payload = json.loads(read_private(path))
        reporter.dispatch(
            request_identity(path),
            path.name.endswith(".task.json"),
            payload,
            receipt,
            phase=phase,
            backfill=backfill,
            attempt=attempt,
        )
    except Exception:  # noqa: BLE001 - logging faults never change the launch fence or retry
        with suppress(OSError):
            print("operations_local_record_failed: coverage_incomplete", flush=True)


def observe_request(reporter, directory, path, *, receipt=False):
    identity = request_identity(path)
    observe_dispatch(
        reporter, path, {"status": "queued"}, phase="discovered", backfill=True
    )
    if reporter is not None and receipt:
        try:
            saved = json.loads(
                read_private(directory / f"{identity}.receipt.json", limit=65536)
            )
        except FileNotFoundError:
            return
        except Exception:  # noqa: BLE001 - private receipt faults are coverage gaps
            with suppress(OSError):
                print("operations_local_record_failed: coverage_incomplete", flush=True)
        else:
            observe_dispatch(reporter, path, saved, phase="receipt", backfill=True)


def recover_receipts(directory, reporter=None):
    # Project only immutable request/receipt metadata; mtimes do not establish
    # when historical queued/running/completed transitions happened.
    if reporter is not None:
        for path in sorted(directory.glob("*.json")):
            if UUID.fullmatch(request_identity(path)):
                observe_request(reporter, directory, path, receipt=True)
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
            request = directory / f"{receipt['id']}.task.json"
            if not request.exists():
                request = directory / f"{receipt['id']}.json"
            if not request.exists():
                request = directory / f"{receipt['id']}.incident.json"
            observe_dispatch(reporter, request, receipt, phase="restart")


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


def dispatch(directory, path, ssh, reporter=None):
    identity = request_identity(path)
    observe_request(reporter, directory, path)
    if not dispatch_due(directory, identity):
        return
    # Classify even pre-readiness receipts without requiring a metadata observer
    # to open diagnostic snapshots or ordinary task prompts/results.
    kind = "amp-task" if path.name.endswith(".task.json") else "debugshare"
    receipt = {
        "id": identity,
        "kind": kind,
        "status": "queued",
        "retryAt": int(time.time() * 1000) + 30000,
    }
    # Queued means no snapshot bytes have been authorized for transport. This
    # retry checkpoint survives dispatcher restarts and does not consume admission.
    save_receipt(directory, receipt)
    observe_dispatch(reporter, path, receipt, phase="readiness", attempt=True)
    payload = None
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
        if payload.get("snapshotOnly") is True:
            # DEBUG is capture-only, even if mistakenly placed in this inbox.
            return
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
                with launch_lock:
                    if not launch_capacity(directory):
                        raise ValueError("debug_launch_budget_exhausted")
                    # Separate metadata keeps older app receipt readers compatible.
                    save_receipt(
                        directory,
                        {"id": identity, "launchedAt": int(time.time() * 1000)},
                        "launch",
                    )
                    receipt = {"id": identity, "kind": kind, "status": "running"}
                    save_receipt(directory, receipt)
                observe_dispatch(
                    reporter, path, receipt, phase="launch", payload=payload
                )
                # The endpoint consumes all input before starting Amp, so large
                # snapshots cannot deadlock against Amp's stdout stream.
                process.stdin.write(data)
                process.stdin.close()
                succeeded = False
                result_seen = False
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
                        observe_dispatch(
                            reporter, path, receipt, phase="thread", payload=payload
                        )
                    if message.get("type") == "result":
                        if (
                            result_seen
                            or not receipt.get("threadId")
                            or message.get("session_id") != receipt["threadId"]
                        ):
                            raise ValueError("invalid_debug_result")
                        result_seen = True
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
    observe_dispatch(
        reporter,
        path,
        receipt,
        phase="readiness" if receipt["status"] == "queued" else "terminal",
        payload=payload,
    )


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
    with open(directory / ".dispatcher.lock", "a") as lock, ExitStack() as cleanup:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        reporter = operations_reporter(config.get("operations"))
        if reporter is not None:
            cleanup.callback(reporter.close)
        recover_receipts(directory, reporter)
        workers = {}
        observed = set()
        while True:
            workers = {
                identity: worker
                for identity, worker in workers.items()
                if worker.is_alive()
            }
            for path in sorted(directory.glob("*.json")):
                identity = request_identity(path)
                if UUID.fullmatch(identity) and identity not in observed:
                    # A queued request is visible even before a worker/thread
                    # exists, including requests waiting for a readiness retry.
                    observe_request(reporter, directory, path)
                    observed.add(identity)
                if (
                    UUID.fullmatch(identity)
                    and identity not in workers
                    and len(workers) < MAX_ACTIVE
                    and launch_capacity(directory)
                    and dispatch_due(directory, identity)
                ):
                    # Bounded observers plus durable launch/rate admission.
                    # Track the worker before the next scan, even if it has not
                    # persisted its launch fence yet. The daemon lock excludes
                    # other dispatchers; durable receipts exclude later replay.
                    worker = threading.Thread(
                        target=dispatch,
                        args=(directory, path, ssh, reporter),
                        daemon=True,
                    )
                    worker.start()
                    workers[identity] = worker
            time.sleep(2)


if __name__ == "__main__":
    try:
        main()
    except Exception:  # noqa: BLE001 - never log private payloads or transport errors
        raise SystemExit("june_debugshare_dispatch_failed") from None
