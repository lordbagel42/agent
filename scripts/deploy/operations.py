"""Private, append-only operation metadata. Reporting never authorizes an action.

Install beside deploy.py/debugshare.py. Optional private config:
operations: {origin, tokenFile, database}. The database's existing parent must be
service-owned and 0700; files must be canonical, private and singly linked. Use
the same journal for the controller and its recovery workers, a separate one for
the dispatcher. No directory creation, service changes, or retention deletion.

Only the background thread uploads. Short-lived commands may leave pending rows
for the next daemon startup. A conflict is retained for operator reconciliation,
never overwritten. Local write failures leave explicit coverage gaps; a separate
journal cannot atomically commit the underlying action's state too. Backfill can
recover retained deployment events/current receipts, not erased incidents/results.
"""

import ipaddress
import json
import os
import re
import sqlite3
import stat
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from contextlib import closing, suppress
from pathlib import Path

SHA = re.compile(r"[a-f0-9]{40}")
UUID = re.compile(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}", re.IGNORECASE)
SNAPSHOT = re.compile(
    r"[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}",
    re.IGNORECASE,
)
THREAD = re.compile(r"T-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}", re.IGNORECASE)
MAX_INT = 2**53 - 1
DEPLOYMENT_STATUSES = {
    "received",
    "preparing",
    "activating",
    "healthy",
    "reconciled",
    "failed",
    "rolled_back",
    "blocked",
    "superseded",
    "deferred",
    "fetch_failed",
}
PHASES = {
    "standby_starting",
    "standby_ready",
    "pausing",
    "intake_paused",
    "draining",
    "drain_settled",
    "resuming",
    "stop_requested",
    "stopped",
    "activating",
    "active_ready",
    "candidate_draining",
    "rollback_stop_requested",
    "rolling_back",
}
REASONS = {
    "preflight_failed",
    "prior_release_invalid",
    "binding_changed",
    "standby_unavailable",
    "intake_not_settled",
    "cutover_interrupted",
    "lifecycle_failed",
    "actions_pending",
    "actions_unavailable",
    "actions_build_failed",
    "actions_artifact_invalid",
    "actions_policy_changed",
    "actions_build_ready",
    "health_failed",
    "drain_busy",
    "insufficient_disk",
    "resume_failed",
    "current_unhealthy",
    "candidate_not_drained",
    "unsafe_rollback",
    "rollback_unhealthy",
    "activation_unknown",
    "non_fast_forward",
    "fetch_failed",
    "controller_failed",
    "repository_metadata_failed",
    "github_status_publish_failed",
}
RECOVERY_ORDER = {
    "pending": 0,
    "dispatching": 1,
    "unknown": 2,
    "spawned": 3,
    "claimed": 4,
    "reconciled": 5,
}


def now_ms():
    return int(time.time() * 1000)


def valid(pattern, value):
    return value if isinstance(value, str) and pattern.fullmatch(value) else None


def integer(value):
    return value if type(value) is int and 0 <= value <= MAX_INT else None


def reason_code(value):
    return value if isinstance(value, str) and value in REASONS else "unrecognized"


def incident_id(value):
    # Controller incident numbers may be nanoseconds, larger than JS safe ints.
    return f"recovery:{value}" if type(value) is int and 0 <= value < 10**30 else None


def private_path(value, *, database=False):
    if not isinstance(value, str):
        raise TypeError("invalid_operations_path")
    path = Path(value)
    if not path.is_absolute() or str(path) != value or path.resolve() != path:
        raise ValueError("invalid_operations_path")
    if database:
        info = path.parent.lstat()
        if (
            not stat.S_ISDIR(info.st_mode)
            or info.st_uid != os.geteuid()
            or info.st_mode & 0o077
        ):
            raise ValueError("unsafe_operations_directory")
    return path


def check_file(path, *, token=False):
    info = path.lstat()
    if (
        not stat.S_ISREG(info.st_mode)
        or info.st_nlink != 1
        or info.st_mode & 0o077
        or info.st_uid not in ({0, os.geteuid()} if token else {os.geteuid()})
    ):
        raise ValueError("unsafe_operations_file")


def canonical_origin(value):
    if not isinstance(value, str) or not value.isascii():
        raise ValueError("invalid_operations_origin")
    parsed = urllib.parse.urlsplit(value)
    host = parsed.hostname or ""
    if "%" in host:
        raise ValueError("invalid_operations_origin")
    if ":" in host:
        host = f"[{ipaddress.IPv6Address(host)}]"
    elif not re.fullmatch(r"[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?", host):
        raise ValueError("invalid_operations_origin")
    elif re.fullmatch(r"(?:[0-9]+|0x[0-9a-f]+)", host.rsplit(".", 1)[-1]):
        # Reject shorthand/octal/hex IPv4 spellings normalized by URL parsers.
        host = str(ipaddress.IPv4Address(host))
    port = parsed.port
    authority = host + (f":{port}" if port is not None else "")
    if (
        value != f"{parsed.scheme}://{authority}"
        or (
            parsed.scheme != "https"
            and not (
                parsed.scheme == "http" and host in {"localhost", "127.0.0.1", "[::1]"}
            )
        )
        or port == (443 if parsed.scheme == "https" else 80)
        or port == 0
    ):
        raise ValueError("invalid_operations_origin")
    return value


class RedirectDenied(ValueError):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        raise RedirectDenied("operations_redirect_denied")


class Reporter:
    def __init__(self, config):
        if not isinstance(config, dict) or set(config) != {
            "origin",
            "tokenFile",
            "database",
        }:
            raise ValueError("invalid_operations_config")
        self.origin = canonical_origin(config["origin"])
        self.token_file = private_path(config["tokenFile"])
        check_file(self.token_file, token=True)
        self.database = private_path(config["database"], database=True)
        if self.database == self.token_file:
            raise ValueError("invalid_operations_database")
        try:
            fd = os.open(
                self.database,
                os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW,
                0o600,
            )
        except FileExistsError:
            pass
        else:
            os.close(fd)
        with closing(self.connect()) as db, db:
            db.executescript("""
                PRAGMA synchronous=FULL;
                CREATE TABLE IF NOT EXISTS operation_destination (
                  singleton INTEGER PRIMARY KEY CHECK(singleton=1), origin TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS operation_journal (
                  position INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE,
                  operation_id TEXT NOT NULL, sequence INTEGER NOT NULL,
                  dedupe_key TEXT UNIQUE, payload TEXT NOT NULL,
                  state TEXT NOT NULL DEFAULT 'pending', failures INTEGER NOT NULL DEFAULT 0,
                  retry_at INTEGER NOT NULL DEFAULT 0, UNIQUE(operation_id,sequence));
                CREATE INDEX IF NOT EXISTS operation_uploads ON operation_journal(state,retry_at);
            """)
            db.execute(
                "INSERT OR IGNORE INTO operation_destination VALUES(1,?)",
                (self.origin,),
            )
            if (
                db.execute(
                    "SELECT origin FROM operation_destination WHERE singleton=1"
                ).fetchone()[0]
                != self.origin
            ):
                raise ValueError("operations_destination_changed")
        fd = os.open(self.database.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
        self.stopped = threading.Event()
        self.worker = None

    def connect(self):
        private_path(str(self.database), database=True)
        check_file(self.database)
        for suffix in ("-journal", "-wal", "-shm"):
            sidecar = Path(str(self.database) + suffix)
            if os.path.lexists(sidecar):
                check_file(sidecar)
        # Bound lock contention on the source path; failures never gate actions.
        db = sqlite3.connect(self.database.as_uri() + "?mode=rw", uri=True, timeout=0.1)
        db.row_factory = sqlite3.Row
        return db

    def append(
        self,
        observation,
        *,
        key=None,
        heartbeat=False,
        attempt=False,
        receipt_backfill=False,
        refresh=False,
    ):
        with closing(self.connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            if (
                key
                and db.execute(
                    "SELECT 1 FROM operation_journal WHERE dedupe_key=?", (key,)
                ).fetchone()
            ):
                return
            previous = db.execute(
                "SELECT payload FROM operation_journal WHERE operation_id=? ORDER BY sequence DESC LIMIT 1",
                (observation["operationId"],),
            ).fetchone()
            previous = json.loads(previous[0]) if previous else None
            if previous and (heartbeat or refresh):
                comparable = {
                    name: value
                    for name, value in previous.items()
                    if name not in {"id", "sequence", "observedAt", "occurredAt"}
                }
                current = {
                    name: value
                    for name, value in observation.items()
                    if name != "occurredAt"
                }
                if comparable == current and (
                    refresh or now_ms() - previous["observedAt"] < 30000
                ):
                    return
            if (
                previous
                and receipt_backfill
                and all(
                    previous.get(name) == observation.get(name)
                    for name in ("status", "threadId", "retryAt")
                )
            ):
                return
            if attempt:
                observation["attempt"] = (previous or {}).get("attempt", 0) + 1
            elif (
                observation["source"] in {"debugshare", "amp-task"}
                and previous
                and "attempt" in previous
            ):
                observation["attempt"] = previous["attempt"]
            event = {
                "id": str(uuid.uuid4()),
                **observation,
                "sequence": previous["sequence"] + 1 if previous else 0,
                "observedAt": now_ms(),
            }
            payload = json.dumps(event, separators=(",", ":"), allow_nan=False)
            if len(payload.encode()) > 16384:
                raise ValueError("operations_event_too_large")
            db.execute(
                "INSERT INTO operation_journal(id,operation_id,sequence,dedupe_key,payload) VALUES (?,?,?,?,?)",
                (event["id"], event["operationId"], event["sequence"], key, payload),
            )
            if previous and (
                observation.get("phase") == "discovered"
                or (
                    observation["source"] == "recovery"
                    and RECOVERY_ORDER[previous["status"]]
                    > RECOVERY_ORDER[observation["status"]]
                )
            ):
                # The CAS worker can observe spawn just after the owner claimed
                # it. Retain the delayed transition, then re-observe the known
                # later state so delivery order cannot undo ownership/resolution.
                restored = {
                    **previous,
                    "id": str(uuid.uuid4()),
                    "sequence": event["sequence"] + 1,
                    "observedAt": now_ms(),
                }
                db.execute(
                    "INSERT INTO operation_journal(id,operation_id,sequence,payload) VALUES (?,?,?,?)",
                    (
                        restored["id"],
                        restored["operationId"],
                        restored["sequence"],
                        json.dumps(restored, separators=(",", ":")),
                    ),
                )
            return True

    def deployment(self, row, *, refresh=False):
        commit = valid(SHA, row["revision"])
        if not commit:
            raise ValueError("invalid_operations_revision")
        status = row["status"] if row["status"] in DEPLOYMENT_STATUSES else "unknown"
        observation = {
            "operationId": f"deployment:{commit}",
            "source": "deployment",
            "occurredAt": integer(row["at"]),
            "status": status,
            "failure": status
            in {"failed", "blocked", "rolled_back", "fetch_failed", "unknown"},
            "revision": commit,
            "phase": "deployment",
        }
        if row["reason"]:
            observation["reason"] = reason_code(row["reason"])
        return self.append(
            observation,
            key=None if refresh else f"deployment_event:{row['sequence']}",
            refresh=refresh,
        )

    def checkpoint(self, commit, record, *, backfill=False):
        if (
            not valid(SHA, commit)
            or record["phase"] not in PHASES
            or type(record["attempt"]) is not int
            or not 0 <= record["attempt"] < 10**30
        ):
            raise ValueError("invalid_operations_checkpoint")
        self.append(
            {
                "operationId": f"deployment:{commit}",
                "source": "deployment",
                "occurredAt": None if backfill else now_ms(),
                "status": "activating",
                "failure": False,
                "revision": commit,
                "phase": record["phase"],
            },
            key=None
            if backfill
            else f"checkpoint:{commit}:{record['attempt']}:{record['phase']}",
            refresh=backfill,
        )

    def recovery(self, incident, *, status=None, backfill=False):
        if not incident:
            return
        if isinstance(incident, str):
            incident = json.loads(incident)
        identity = incident_id(incident.get("incident"))
        if identity is None:
            raise ValueError("invalid_operations_incident")
        status = status or (
            "claimed" if valid(THREAD, incident.get("owner")) else incident.get("phase")
        )
        if status not in {
            "pending",
            "dispatching",
            "spawned",
            "claimed",
            "reconciled",
            "unknown",
        }:
            raise ValueError("invalid_operations_recovery")
        observation = {
            "operationId": identity,
            "source": "recovery",
            "occurredAt": None if backfill else now_ms(),
            "status": status,
            "failure": status in {"pending", "unknown"},
            "phase": "recovery",
            "reason": reason_code(incident.get("reason")),
        }
        commit = valid(SHA, incident.get("revision"))
        if commit:
            observation.update(
                revision=commit, relatedOperationId=f"deployment:{commit}"
            )
        thread = valid(THREAD, incident.get("thread"))
        if thread:
            observation["threadId"] = thread
        self.append(observation, key=f"{identity}:{status}")

    def backfill(self, store):
        latest, added = {}, set()
        for row in store.db.execute("SELECT * FROM events ORDER BY sequence"):
            latest[row["revision"]] = row
            if self.deployment(row):
                added.add(row["revision"])
        # Filling a hole behind an already-published event must not make that
        # historical failure the current result. Re-observe only affected heads.
        for commit in added:
            self.deployment(latest[commit], refresh=True)
        cutover = json.loads(store.get("cutover") or "{}")
        if cutover.get("revision") in added:
            self.checkpoint(cutover["revision"], cutover, backfill=True)
        self.current_recovery(store)

    def current_recovery(self, store):
        self.recovery(store.get("recovery"), backfill=True)

    def controller(self, store):
        def state(key):
            return json.loads(store.get(key) or "{}")

        cutover, recovery, retry = state("cutover"), state("recovery"), state("retry")
        queue = [
            value
            for value in state("queue").get("pending", [])
            if valid(SHA, value) and store.pending(value)
        ]
        phase = cutover.get("phase") if cutover.get("phase") in PHASES else None
        hold, blocked = bool(store.get("operatorHold")), bool(store.get("blocked"))
        after = retry.get("after")
        retry_at = integer(int(after * 1000)) if type(after) in (int, float) else None
        observation = {
            "operationId": "controller:deployment",
            "source": "controller",
            "occurredAt": now_ms(),
            "status": "blocked"
            if blocked or hold or recovery
            else ("activating" if phase else "deferred" if retry else "idle"),
            "failure": blocked,
            "controller": {
                "activeRevision": valid(SHA, store.get("active")),
                "observedRevision": valid(SHA, store.get("observed")),
                "targetRevision": valid(SHA, store.get("intent"))
                or (queue[-1] if queue else None),
                "controllerRevision": valid(SHA, store.controller_revision),
                "blocked": bool(blocked or hold or recovery),
                "operatorHold": hold,
                "phase": phase,
                "recoveryIncident": incident_id(recovery.get("incident")),
                "recoveryThreadId": valid(THREAD, recovery.get("thread")),
                "recoveryOwner": valid(THREAD, recovery.get("owner")),
                "retryAttempts": integer(retry.get("attempts")),
                "retryAt": retry_at,
                "queuedRevisions": queue[:50],
                "omittedQueueCount": max(0, len(queue) - 50),
            },
        }
        if blocked:
            observation["reason"] = reason_code(store.get("blocked"))
        elif hold:
            observation["reason"] = "operator_hold"
        elif recovery:
            observation["reason"] = (
                "recovery_owned" if recovery.get("owner") else "recovery_pending"
            )
        elif retry:
            observation["reason"] = reason_code(retry.get("reason"))
        self.append(observation, heartbeat=True)

    def dispatch(
        self, identity, task, payload, receipt, *, phase, backfill=False, attempt=False
    ):
        if payload.get("snapshotOnly") is True:
            return
        if (
            not valid(UUID, identity)
            or payload.get("id") != identity
            or payload.get("kind") not in (None, "amp-task")
            or (payload.get("kind") == "amp-task") != task
            or ("id" in receipt and receipt["id"] != identity)
        ):
            raise ValueError("invalid_operations_request")
        status = receipt["status"]
        if status not in {"queued", "running", "completed", "unknown"} or phase not in {
            "discovered",
            "readiness",
            "launch",
            "thread",
            "terminal",
            "restart",
            "receipt",
        }:
            raise ValueError("invalid_operations_receipt")
        source = "amp-task" if task else "debugshare"
        observation = {
            "operationId": f"{source}:{identity}",
            "source": source,
            "occurredAt": None if backfill else now_ms(),
            "status": status,
            "failure": status == "unknown" or (phase == "readiness" and not attempt),
            "phase": phase,
        }
        for name, value in (
            ("threadId", valid(THREAD, receipt.get("threadId"))),
            ("retryAt", integer(receipt.get("retryAt"))),
            ("revision", valid(SHA, payload.get("revision"))),
        ):
            if value is not None:
                observation[name] = value
        if not task and valid(SNAPSHOT, identity):
            observation["snapshotId"] = identity
        if status == "unknown":
            observation["reason"] = (
                "dispatcher_restarted" if phase == "restart" else "launch_unconfirmed"
            )
        elif phase == "readiness" and not attempt:
            observation["reason"] = "readiness_unavailable"
        self.append(
            observation,
            key=f"request:{source}:{identity}" if phase == "discovered" else None,
            attempt=attempt,
            receipt_backfill=backfill and phase == "receipt",
        )

    def token(self):
        private_path(str(self.token_file))
        check_file(self.token_file, token=True)
        fd = os.open(self.token_file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as file:
            info = os.fstat(file.fileno())
            if (
                not stat.S_ISREG(info.st_mode)
                or info.st_mode & 0o077
                or info.st_uid not in {0, os.geteuid()}
                or info.st_nlink != 1
                or info.st_size > 4097
            ):
                raise ValueError("unsafe_operations_token")
            data = file.read(4098)
        token = data.decode("ascii").strip()
        if not 32 <= len(token) <= 4096 or not re.fullmatch(
            r"[A-Za-z0-9._~+/-]+=*", token
        ):
            raise ValueError("invalid_operations_token")
        return token

    def upload_pending(self):
        # No source/journal transaction is held over an HTTP call. Immutable bytes
        # are retained even after an ack is lost or a process exits mid-upload.
        with closing(self.connect()) as db:
            rows = db.execute(
                "SELECT * FROM operation_journal WHERE state='pending' AND retry_at<=? ORDER BY position LIMIT 10",
                (now_ms(),),
            ).fetchall()
        for row in rows:
            if self.stopped.is_set():
                return
            state = "pending"
            try:
                request = urllib.request.Request(
                    self.origin + "/api/ingest/operations/" + row["id"],
                    method="PUT",
                    data=row["payload"].encode(),
                    headers={
                        "Authorization": "Bearer " + self.token(),
                        "Content-Type": "application/json",
                    },
                )
                opener = urllib.request.build_opener(
                    urllib.request.ProxyHandler({}), NoRedirect()
                )
                with opener.open(request, timeout=5) as response:
                    body = response.read(4097)
                    if response.status not in (200, 201) or len(body) > 4096:
                        raise ValueError("invalid_operations_ack")
                    ack = json.loads(body)
                    if (
                        not isinstance(ack, dict)
                        or set(ack) != {"id", "saved"}
                        or ack["id"] != row["id"]
                        or ack["saved"] is not True
                    ):
                        raise ValueError("invalid_operations_ack")
                state = "saved"
            except RedirectDenied:
                state = "rejected"
            except urllib.error.HTTPError as error:
                with error:
                    if error.code == 409:
                        state = "conflict"
                    elif error.code < 500 and error.code not in (408, 425, 429):
                        state = "rejected"
            except Exception:  # noqa: BLE001,S110 - never disclose URLs, tokens or response/error bodies
                pass
            if state != "saved":
                with suppress(OSError):
                    print(
                        "operations_retained: reconciliation_required"
                        if state in {"conflict", "rejected"}
                        else "operations_upload_pending",
                        flush=True,
                    )
            with closing(self.connect()) as db, db:
                db.execute(
                    "UPDATE operation_journal SET state=?,failures=failures+1,retry_at=? WHERE id=? AND state='pending'",
                    (
                        state,
                        now_ms() + min(300000, 5000 * 2 ** min(row["failures"], 6)),
                        row["id"],
                    ),
                )

    def start(self):
        if self.worker is not None:
            return

        def upload():
            while not self.stopped.wait(1):
                try:
                    self.upload_pending()
                except Exception:  # noqa: BLE001 - no action-policy effects, no private data
                    with suppress(OSError):
                        print(
                            "operations_uploader_failed: pending_retained", flush=True
                        )

        self.worker = threading.Thread(
            target=upload, name="operations-uploader", daemon=True
        )
        self.worker.start()

    def close(self):
        # Never wait for a network operation on the controller/launch path.
        self.stopped.set()
