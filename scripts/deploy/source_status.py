"""Optional host-observed issue-source exporter. No agents, snapshots or GitHub API.

Install source_status.py and issues.py root-owned outside releases on June's host,
then explicitly authorize/configure june-issue-sources.service. Publication alone
does not activate it. /etc/june-issues/sources.json must be root-owned 0600:
  {"origin":"https://debug.raygen.dev",
   "tokenFile":"/etc/june-issues/automation-token",
   "debugDirectory":"/var/lib/june-debugshare",
   "recoveryDatabase":"/var/lib/june-deploy/records/deploy.sqlite"}
Use the separate automation token, never ingest/viewer credentials. Paths must be
canonical; DEBUGSHARE state belongs to june, recovery state to root. No command,
runner, SSH, launch, diagnostic ingest, or issue-completion interface is provided.

Minimal recovery receipts are recorded locally even without issueTracker. This
explicit exporter installation/config is the opt-in replacing dispatch's one-shot
issueTracker HTTP: neither that old setting nor local receipts enable publication.
Only current verified metadata is retried; no receipt is modified or deleted.
Running is a recorded launch/observation, not a liveness guarantee. Returned means
a matching successful terminal record AND exit, not repair or issue completion.
Legacy untyped DEBUGSHARE receipts require a private UUID.json filename (stat only)
and no UUID.task.json. Ambiguous/malformed sources are skipped, not guessed.
"""

import hashlib
import importlib.util
import json
import os
import pwd
import sqlite3
import stat
import time
from collections import OrderedDict
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "issues", Path(__file__).with_name("issues.py")
)
issues = importlib.util.module_from_spec(spec)
spec.loader.exec_module(issues)

CONFIG = "/etc/june-issues/sources.json"
ROOT_UID = 0
BATCH_SIZE = 16  # At most this many directory entries and SQLite rows per poll.
CACHE_SIZE = 4096
POLL_SECONDS = 15
RECEIPT_LIMIT = 65_536
SOURCE_LIMIT = 1024
PREFIX = "issue-source:recovery:"
PHASES = ("unavailable", "queued", "running", "unknown", "returned")


def canonical(value):
    if not issues.absolute(value) or len(value) > 4096:
        raise ValueError("invalid_source_path")
    path = Path(value)
    try:
        if path.resolve() != path:
            raise ValueError("invalid_source_path")
    except (OSError, RuntimeError):
        raise ValueError("invalid_source_path") from None
    return path


def validate_config(config):
    if not isinstance(config, dict) or set(config) != {
        "origin",
        "tokenFile",
        "debugDirectory",
        "recoveryDatabase",
    }:
        raise ValueError("invalid_source_config")
    issues.validate_origin(config["origin"])
    for name in ("tokenFile", "debugDirectory", "recoveryDatabase"):
        canonical(config[name])
    return config


def private_path(path, owner, *, directory=False):
    path = canonical(str(path))
    info = path.lstat()
    if (
        info.st_uid != owner
        or info.st_mode & 0o077
        or (
            not stat.S_ISDIR(info.st_mode)
            if directory
            else not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
        )
    ):
        raise ValueError("unsafe_source_path")
    return path


def metadata(value):
    if (
        not isinstance(value, dict)
        or value.keys() - {"source", "phase", "threadId", "revision"}
        or not issues.source_valid(value.get("source"))
        or value.get("phase") not in PHASES
        or (
            "threadId" in value and not issues.matches(issues.THREAD, value["threadId"])
        )
        or ("revision" in value and not issues.matches(issues.SHA, value["revision"]))
        or (value["phase"] == "returned" and "threadId" not in value)
    ):
        raise ValueError("invalid_source_metadata")
    return value


def debug_metadata(directory, name, owner):
    identity = name.removesuffix(".receipt.json")
    if not name.endswith(".receipt.json") or not issues.matches(issues.UUID, identity):
        return None
    # Reject ordinary task filenames before even reading their receipts/results.
    if os.path.lexists(directory / f"{identity}.task.json"):
        return None
    value = issues.parse_json(
        issues.read_private(directory / name, owner=owner, limit=RECEIPT_LIMIT)
    )
    if (
        not isinstance(value, dict)
        or value.get("id") != identity
        or value.get("kind") not in (None, "debugshare")
        or value.keys()
        - {"id", "kind", "status", "threadId", "retryAt", "revision", "resolved"}
        or ("resolved" in value and value["resolved"] is not True)
        or value.get("status") not in ("queued", "running", "completed", "unknown")
    ):
        return None
    if value.get("kind") is None:
        private_path(directory / f"{identity}.json", owner)  # Never open a snapshot.
    # Resolution attestations belong to June's notification path. They neither
    # publish code nor close issues, and never leave this host via this exporter.
    phase = value["status"]
    if phase == "completed":
        phase = "returned" if "threadId" in value else "unknown"
    return metadata(
        {
            "source": f"debug:{identity}",
            "phase": phase,
            **{key: value[key] for key in ("threadId", "revision") if key in value},
        }
    )


class Exporter:
    def __init__(self, config, api, debug_owner):
        self.config = validate_config(config)
        self.api, self.debug_owner = api, debug_owner
        self.entries = None
        self.recovery_cursor = ""
        self.acknowledged = OrderedDict()

    def close(self):
        if self.entries is not None:
            self.entries.close()
            self.entries = None

    def debug_batch(self):
        batch = []
        try:
            directory = private_path(
                self.config["debugDirectory"], self.debug_owner, directory=True
            )
            if self.entries is None:
                self.entries = os.scandir(directory)
            for _ in range(BATCH_SIZE):
                entry = next(self.entries, None)
                if entry is None:
                    self.close()
                    break
                try:
                    value = debug_metadata(directory, entry.name, self.debug_owner)
                    if value is not None:
                        batch.append(value)
                except (OSError, ValueError):
                    continue  # One invalid/private receipt must not block others.
        except (OSError, ValueError):
            self.close()
        return batch

    def recovery_batch(self):
        batch = []
        try:
            database = private_path(self.config["recoveryDatabase"], ROOT_UID)
            private_path(database.parent, ROOT_UID, directory=True)
            db = sqlite3.connect(database.as_uri() + "?mode=ro", uri=True, timeout=0.1)
            try:
                db.execute("PRAGMA query_only=ON")
                db.execute("PRAGMA trusted_schema=OFF")
                deadline = time.monotonic() + 1
                db.set_progress_handler(lambda: time.monotonic() >= deadline, 1000)
                rows = db.execute(
                    "SELECT key, CASE WHEN length(CAST(value AS BLOB))<=? THEN value END "
                    "FROM state WHERE key>=? AND key<? AND key>? "
                    "AND length(key)<=80 ORDER BY key LIMIT ?",
                    (
                        SOURCE_LIMIT,
                        PREFIX,
                        "issue-source:recovery;",
                        self.recovery_cursor,
                        BATCH_SIZE,
                    ),
                ).fetchall()
            finally:
                # Close even the read-only connection before ANY HTTP attempt.
                db.close()
            self.recovery_cursor = rows[-1][0] if len(rows) == BATCH_SIZE else ""
            for key, raw in rows:
                try:
                    value = (
                        metadata(issues.parse_json(raw)) if raw is not None else None
                    )
                    if value is not None and key == "issue-source:" + value["source"]:
                        batch.append(value)
                except ValueError:
                    continue
        except (OSError, ValueError, sqlite3.Error):
            self.recovery_cursor = ""
        return batch

    def poll_once(self):
        # Fresh bounded pages, not a stale retry queue. The API enforces monotonic
        # state across exporter restarts, cache eviction and response loss.
        batch = self.debug_batch() + self.recovery_batch()
        for value in batch:
            source, phase = value["source"], value["phase"]
            fingerprint = hashlib.sha256(
                json.dumps(value, sort_keys=True).encode()
            ).digest()
            previous = self.acknowledged.get(source)
            if previous:
                digest, previous_phase, thread = previous
                if (
                    digest == fingerprint
                    or PHASES.index(previous_phase) > PHASES.index(phase)
                    or (thread is not None and value.get("threadId") != thread)
                ):
                    self.acknowledged.move_to_end(source)
                    continue
            try:
                response = self.api("/api/issue-sources", value)
                if not isinstance(response, dict) or response.get("ok") is False:
                    continue
            except (OSError, ValueError):
                continue  # Metadata POST is idempotent; nothing launches or closes.
            self.acknowledged[source] = (fingerprint, phase, value.get("threadId"))
            self.acknowledged.move_to_end(source)
            while len(self.acknowledged) > CACHE_SIZE:
                self.acknowledged.popitem(last=False)


def main():
    os.umask(0o077)
    if os.geteuid() != ROOT_UID:
        raise ValueError("source_root_required")
    config = validate_config(issues.parse_json(issues.read_private(CONFIG, limit=4096)))
    client = issues.Client(config)
    exporter = Exporter(config, client.post, pwd.getpwnam("june").pw_uid)
    try:
        while True:
            exporter.poll_once()
            time.sleep(POLL_SECONDS)
    finally:
        exporter.close()


if __name__ == "__main__":
    try:
        main()
    except Exception:  # noqa: BLE001 - no credentials, responses or private filenames in logs
        raise SystemExit("june_issue_sources_unavailable") from None
