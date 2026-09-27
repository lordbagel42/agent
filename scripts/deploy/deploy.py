"""June-only pull deployment. Install outside releases; run with a single flock.

Trusted main authorizes forward deployment, not database restore or arbitrary
host commands. Errors are fixed codes: subprocess/HTTP output never enters June.
"""

import argparse
import fcntl
import hashlib
import io
import json
import os
import pwd
import re
import shutil
import sqlite3
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.request
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import ClassVar

REPOSITORY = "git@github.com:lordbagel42/agent.git"
SOURCE = (
    "src",
    "tests",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "tsconfig.json",
    "vitest.config.ts",
    "biome.json",
    ".gitignore",
    ".npmrc",
    ".node-version",
)
SHA = re.compile(r"^[0-9a-f]{40}$")
HASH = re.compile(r"^[0-9a-f]{64}$")
STAGE = re.compile(r"^stage-[a-z0-9_]{8}$")


class InsufficientDisk(Exception):
    pass


def revision(value):
    if not isinstance(value, str) or not SHA.fullmatch(value):
        raise ValueError("invalid_revision")
    return value


@contextmanager
def deployment_lock(path):
    fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        os.close(fd)


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def atomic_json(path, value, mode=0o600, gid=None):
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as file:
        temporary = Path(file.name)
        try:
            file.write(json.dumps(value, separators=(",", ":")).encode())
            file.flush()
            os.fchmod(file.fileno(), mode)
            if gid is not None:
                os.fchown(file.fileno(), -1, gid)
            os.fsync(file.fileno())
            os.replace(temporary, path)
            sync_directory(path.parent)
        finally:
            temporary.unlink(missing_ok=True)


class Store:
    def __init__(
        self,
        root,
        feed,
        initial,
        feed_gid=None,
        controller_revision=None,
        *,
        staging_recovery_feed=False,
    ):
        self.feed, self.feed_gid = feed, feed_gid
        self.staging_recovery_feed = staging_recovery_feed
        self.initial = revision(initial)
        self.controller_revision = (
            revision(controller_revision) if controller_revision is not None else None
        )
        root.mkdir(mode=0o700, exist_ok=True)
        self.db = sqlite3.connect(root / "deploy.sqlite")
        self.db.row_factory = sqlite3.Row
        self.db.executescript("""
            PRAGMA synchronous=FULL;
            CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS events(
              sequence INTEGER PRIMARY KEY, revision TEXT NOT NULL, status TEXT NOT NULL,
              at INTEGER NOT NULL, committedAt INTEGER, reason TEXT, elapsedMs INTEGER);
        """)
        with self.db:
            self.db.executemany(
                "INSERT OR IGNORE INTO state VALUES (?,?)",
                [("active", revision(initial)), ("observed", initial)],
            )
        sync_directory(root)
        self.publish()

    def close(self):
        self.db.close()

    def get(self, key):
        row = self.db.execute("SELECT value FROM state WHERE key=?", (key,)).fetchone()
        return row[0] if row else ""

    def set(self, key, value):
        with self.db:
            self.db.execute("INSERT OR REPLACE INTO state VALUES (?,?)", (key, value))

    def status(self, commit):
        row = self.db.execute(
            "SELECT status FROM events WHERE revision=? AND status!='fetch_failed' ORDER BY sequence DESC LIMIT 1",
            (commit,),
        ).fetchone()
        return row[0] if row else None

    def obsolete(self, keep):
        recent = {
            row[0]
            for row in self.db.execute(
                "SELECT revision FROM events WHERE status IN ('healthy','reconciled') GROUP BY revision ORDER BY MAX(sequence) DESC LIMIT 2"
            )
        }
        known = {
            row[0]
            for row in self.db.execute(
                "SELECT DISTINCT revision FROM events WHERE status IN ('healthy','reconciled','failed','rolled_back','superseded')"
            )
        }
        return known - {self.initial, *keep, *recent}

    def event(self, commit, status, reason=None, committed_at=None):
        now = time.time_ns() // 1_000_000
        previous = self.db.execute(
            "SELECT status,reason FROM events WHERE revision=? ORDER BY sequence DESC LIMIT 1",
            (commit,),
        ).fetchone()
        received = self.db.execute(
            "SELECT at,committedAt FROM events WHERE revision=? AND status='received' LIMIT 1",
            (commit,),
        ).fetchone()
        with self.db:
            if status in ("healthy", "reconciled"):
                self.db.execute(
                    "UPDATE state SET value=? WHERE key='active'", (commit,)
                )
            if status in ("healthy", "rolled_back", "reconciled"):
                self.db.execute("UPDATE state SET value='' WHERE key='intent'")
            if status == "reconciled":
                self.db.execute("UPDATE state SET value='' WHERE key='blocked'")
            # Deduplicate history, not current state: another revision may have
            # left an ambiguous intent since this revision was last reconciled.
            if not previous or tuple(previous) != (status, reason):
                self.db.execute(
                    "INSERT INTO events(revision,status,at,committedAt,reason,elapsedMs) VALUES (?,?,?,?,?,?)",
                    (
                        revision(commit),
                        status,
                        now,
                        received[1] if received else committed_at,
                        reason,
                        max(0, now - received[0]) if received else None,
                    ),
                )
        self.publish()

    def block(self, commit, reason):
        self.set("blocked", reason)
        self.event(commit, "blocked", reason)

    def stage_recovery(self, removed):
        if type(removed) is not int or not 0 < removed <= 2**53 - 1:
            return
        # Global maintenance evidence, never attributed to observed/active SHA.
        # A crash after removal but before this receipt leaves recovery unknown.
        self.set(
            "lastStageRecovery",
            json.dumps({"at": time.time_ns() // 1_000_000, "removed": removed}),
        )
        self.publish()

    def publish(self):
        events = [
            dict(row)
            for row in self.db.execute(
                "SELECT * FROM events ORDER BY sequence DESC LIMIT 100"
            )
        ][::-1]
        recovery = self.get("lastStageRecovery") if self.staging_recovery_feed else ""
        atomic_json(
            self.feed,
            {
                "version": 1,
                "repository": "lordbagel42/agent",
                "branch": "main",
                "lastHealthyRevision": self.get("active"),
                # Legacy readers reject additional keys. Publish this extension
                # only after the operator provisions verified install provenance.
                **(
                    {"controllerRevision": self.controller_revision}
                    if self.controller_revision is not None
                    else {}
                ),
                "blocked": bool(self.get("blocked")),
                "events": events,
                **({"lastStageRecovery": json.loads(recovery)} if recovery else {}),
            },
            0o640,
            self.feed_gid,
        )


class Deployer:
    def __init__(self, host, store, statuses=None):
        self.host, self.store = host, store
        self.statuses = statuses
        if store.get("intent") and not store.get("blocked"):
            store.block(store.get("intent"), "activation_unknown")

    def reconcile(self, commit):
        # Root-only observation after an operator fences all prior operations.
        # Does not start, stop, clear a journal, or retry an earlier effect.
        self.host.manifest(revision(commit))
        if not self.host.settled() or not self.host.healthy(commit):
            raise ValueError("reconciliation_not_ready")
        self.store.event(commit, "reconciled")

    def observe(self):
        h, s = self.host, self.store
        head = revision(h.fetch())
        before = s.get("observed")
        saved = s.get("queue")
        admission = json.loads(saved) if saved else None
        # Queue admission can survive a crash before the observation cursor.
        # Its ancestry boundary must survive completion/removal of queue entries.
        for anchor in {before, admission["tip"] if admission else before} - {head}:
            try:
                h.git("merge-base", "--is-ancestor", anchor, head)
            except subprocess.CalledProcessError:
                s.event(head, "received", committed_at=h.committed_at(head))
                s.block(head, "non_fast_forward")
                return head
        if admission:
            queued = admission["pending"]
        else:
            # One-time adoption of unfinished legacy work in receipt order.
            # An interrupted old observation may have recorded an intermediate
            # as received without ever admitting that head. Only adopt received
            # history covered by its durable observed cursor; preparation or
            # deferral independently proves that a candidate was picked up.
            queued = []
            pending = s.db.execute("""
                SELECT revision,status FROM events AS latest WHERE sequence IN (
                  SELECT MAX(sequence) FROM events WHERE status!='fetch_failed'
                  GROUP BY revision
                ) AND status IN ('received','preparing','deferred')
                ORDER BY (SELECT MIN(sequence) FROM events WHERE revision=latest.revision)
            """).fetchall()
            for row in pending:
                if row["status"] == "received":
                    try:
                        h.git("merge-base", "--is-ancestor", row["revision"], before)
                    except subprocess.CalledProcessError as error:
                        if error.returncode == 1:
                            continue
                        raise
                queued.append(row["revision"])
        queued = [
            commit
            for commit in queued
            if s.status(commit) in (None, "received", "preparing", "deferred")
        ]
        if (
            head != before
            and head not in queued
            and s.status(head)
            in (
                None,
                "received",
                "preparing",
                "deferred",
            )
        ):
            queued.append(head)
        # Admission precedes receipts and the observation cursor. A restart can
        # replay observation without dropping this head or admitting intermediates.
        admission = json.dumps({"tip": head, "pending": queued})
        if admission != saved:
            s.set("queue", admission)
        for commit in queued:
            if s.status(commit) is None:
                s.event(commit, "received", committed_at=h.committed_at(commit))
        if head != before:
            commits = h.git("rev-list", "--reverse", f"{before}..{head}").splitlines()
            for commit in commits:
                if commit not in queued and s.status(commit) in (None, "received"):
                    s.event(commit, "superseded", committed_at=h.committed_at(commit))
            s.set("observed", head)
        return head

    def resume(self, target):
        try:
            if not self.host.resume(self.store.get("active")):
                raise ValueError("not_resumed")
            self.store.set("intent", "")
        except Exception:  # noqa: BLE001 - external errors must become secret-free records
            self.store.block(target, "resume_failed")

    def tick(self):
        try:
            self.store.stage_recovery(self.host.recover_stages())
            self.deploy()
        finally:
            if self.statuses:
                self.statuses.flush()

    def deploy(self):
        h, s = self.host, self.store
        try:
            self.observe()
        except Exception:  # noqa: BLE001 - never log SSH/credential-helper errors
            s.event(s.get("observed"), "fetch_failed", "fetch_failed")
            return
        if s.get("blocked"):
            return
        queued = json.loads(s.get("queue"))["pending"]
        if not queued:
            return
        target = queued[0]
        previous = s.get("active")
        try:
            if not h.running(previous) or not h.settled():
                s.block(target, "current_unhealthy")
                return
            if target == previous:
                s.event(target, "superseded")
                return
            try:
                h.git("merge-base", "--is-ancestor", previous, target)
            except subprocess.CalledProcessError:
                try:
                    h.git("merge-base", "--is-ancestor", target, previous)
                except subprocess.CalledProcessError:
                    s.block(target, "non_fast_forward")
                else:
                    # Legacy pending work (or an operator's forward jump) may
                    # already be contained by active. Skip, never downgrade or
                    # falsely claim that this exact revision was deployed.
                    s.event(target, "superseded")
                return
            h.prune(s.obsolete({previous, target}))
            # Check before recording preparation so capacity deferrals do not
            # spam the feed or latch a terminal failed revision.
            h.require_space(target)
            s.event(target, "preparing")
            if self.statuses:
                self.statuses.flush()
            candidate = h.prepare(target)
            prior = h.manifest(previous)
            rollback_safe = h.rollback_safe(prior, candidate)
            self.observe()
            if s.get("blocked"):
                s.block(target, s.get("blocked"))
                return
            if not h.healthy(previous):
                s.block(target, "current_unhealthy")
                return
        except InsufficientDisk:
            s.event(target, "deferred", "insufficient_disk")
            return
        except Exception:  # noqa: BLE001 - candidate/build output is private
            s.event(target, "failed", "preflight_failed")
            return
        # Drain changes admission too. A crash must not silently leave the old
        # service fenced without a durable record and explicit reconciliation.
        s.set("intent", target)
        try:
            if not h.drain(previous):
                s.event(target, "deferred", "drain_busy")
                self.resume(target)
                return
            # Refresh ancestry after drain. Descendant arrivals wait for the
            # next tick; a rewrite still blocks activation and resumes admission.
            self.observe()
            if s.get("blocked"):
                s.block(target, s.get("blocked"))
                self.resume(target)
                return
        except Exception:  # noqa: BLE001 - resume even after an ambiguous HTTP error
            s.event(target, "deferred", "drain_busy")
            self.resume(target)
            return
        # The intent is already durable. Never retry an ambiguous stop/start
        # or infer success merely from the current symlink.
        s.event(target, "activating")
        try:
            h.service("stop")
            h.switch(target)
            h.service("start")
            if h.healthy(target):
                s.event(target, "healthy")
                return
            s.event(target, "failed", "health_failed")
            # Never kill a possibly busy candidate just to recover quickly.
            # If it cannot prove quiescence, operator recovery must fence it.
            if not h.drain(target):
                s.block(target, "candidate_not_drained")
                return
            h.service("stop")
            if not rollback_safe:
                s.block(target, "unsafe_rollback")
                return
            h.switch(previous)
            h.service("start")
            if not h.healthy(previous):
                s.block(target, "rollback_unhealthy")
                return
            s.event(target, "rolled_back", "health_failed")
        except Exception:  # noqa: BLE001 - every unknown effect blocks; no error payload
            s.block(target, "activation_unknown")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        raise ValueError("redirect_denied")


class GitHubStatuses:
    """Best-effort mirror of durable evidence, never inside activation/rollback."""

    STAGES: ClassVar = {
        "received": ("queued", None, "Deployment queued"),
        "preparing": ("in_progress", None, "Preparing and checking release"),
        "activating": ("in_progress", None, "Activating release"),
        "deferred": ("queued", None, "Deployment deferred"),
        "healthy": ("completed", "success", "Deployed and verified healthy"),
        "reconciled": ("completed", "success", "Running release verified by operator"),
        "failed": ("completed", "failure", "Deployment failed"),
        "rolled_back": ("completed", "failure", "Deployment failed; rolled back"),
        "blocked": ("completed", "action_required", "Deployment blocked"),
        "superseded": (
            "completed",
            "skipped",
            "Superseded by newer main; not deployed",
        ),
    }
    REASONS: ClassVar = {
        "preflight_failed": "Source preparation or preflight failed; individual command results are not recorded. Operator diagnosis required.",
        "health_failed": "Candidate failed readiness or process-identity checks. Inspect later rollback/block events.",
        "drain_busy": "In-flight work could not be safely drained. The controller will retry without cancelling work.",
        "insufficient_disk": "Insufficient disk capacity. Operator must restore capacity; the controller will retry.",
        "resume_failed": "Admission could not be resumed. Operator recovery required.",
        "current_unhealthy": "Current service identity/readiness is unverified. Operator inspection required.",
        "candidate_not_drained": "Failed candidate could not be safely drained. Operator recovery required; no forced restart.",
        "unsafe_rollback": "Rollback compatibility is not established. Operator forward recovery required; never restore conversation data.",
        "rollback_unhealthy": "Rollback did not establish a healthy service. Operator recovery required.",
        "activation_unknown": "An activation may be incomplete. Operator must establish actual service state and reconcile; no automatic retry.",
        "non_fast_forward": "Main moved backwards or diverged. Owner must resolve trusted branch history.",
    }

    def __init__(self, store):
        self.store = store
        self.retry_at = 0
        self.opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}), NoRedirect()
        )

    def report(self, commit):
        first = self.store.db.execute(
            "SELECT * FROM events WHERE revision=? AND status!='fetch_failed' ORDER BY sequence LIMIT 1",
            (revision(commit),),
        ).fetchone()
        events = self.store.db.execute(
            "SELECT * FROM events WHERE revision=? AND status!='fetch_failed' ORDER BY sequence DESC LIMIT 25",
            (commit,),
        ).fetchall()[::-1]
        latest = events[-1]
        status, conclusion, title = self.STAGES[latest["status"]]

        def timestamp(value):
            return (
                datetime.fromtimestamp(value / 1000, timezone.utc)
                .isoformat()
                .replace("+00:00", "Z")
            )

        def reason(value):
            if value is None:
                return "—"
            if value in self.REASONS:
                return f"`{value}`: {self.REASONS[value]}"
            return "Unrecognized reason; operator diagnosis required."

        summary = [
            f"**{latest['status']}** — {title}",
            f"Revision: [`{commit}`](https://github.com/lordbagel42/agent/commit/{commit}) · `main` · June production",
            f"Reason: {reason(latest['reason'])}",
            f"First recorded: {timestamp(first['at'])} · Latest event: {timestamp(latest['at'])}",
            f"Observation → latest event: {latest['elapsedMs'] / 1000:.2f} s"
            if latest["elapsedMs"] is not None
            else "Observation duration: unknown (no earlier received event).",
            "This is historical deployment evidence, not a claim that this revision is currently running or healthy. June's owner-authenticated release inspection reports loaded process identity separately.",
        ]
        if first["committedAt"] is not None:
            summary.insert(
                4,
                f"Commit timestamp: {timestamp(first['committedAt'])} (not used as deployment start).",
            )
        timeline = [
            "## Recorded stages (UTC)",
            "",
            "| Time | Stage | Reason |",
            "| --- | --- | --- |",
        ]
        timeline.extend(
            f"| {timestamp(event['at'])} | `{event['status'] if event['status'] in self.STAGES else 'unknown'}` | {reason(event['reason'])} |"
            for event in events
        )
        if events[0]["sequence"] != first["sequence"]:
            timeline.append(
                "\nShowing the latest 25 lifecycle events; earlier stages are omitted."
            )
        timeline.append(
            "\nPreparation runs frozen dependency installation, formatting, type checking, safety tests and immutable artifact verification. Activation requires drain, readiness and process-identity checks. This report contains stage outcomes, not individual command results or raw logs; missing evidence is not a passed check."
        )
        payload = {
            "name": "june/deploy",
            "status": status,
            "started_at": timestamp(first["at"]),
            "output": {
                "title": title,
                "summary": "\n\n".join(summary),
                "text": "\n".join(timeline),
            },
        }
        if conclusion:
            payload.update(conclusion=conclusion, completed_at=timestamp(latest["at"]))
        return payload

    def request(self, token, method, path, body=None):
        request = urllib.request.Request(
            "https://api.github.com/repos/lordbagel42/agent/" + path,
            data=json.dumps(body).encode() if body is not None else None,
            method=method,
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/vnd.github+json",
                "Content-Type": "application/json",
                "User-Agent": "june-deploy",
                "X-GitHub-Api-Version": "2026-03-10",
            },
        )
        try:
            with self.opener.open(request, timeout=5) as response:
                if response.status != (201 if method == "POST" else 200):
                    raise ValueError("github_status_failed")
                data = response.read(1024 * 1024 + 1)
                if len(data) > 1024 * 1024:
                    raise ValueError("github_response_too_large")
                return json.loads(data)
        except urllib.error.HTTPError as error:
            error.close()
            raise ValueError("github_status_failed") from None

    def flush(self):
        if time.monotonic() < self.retry_at:
            return
        try:
            try:
                token = private_file(Path("/etc/june/github-status-token")).strip()
            except FileNotFoundError:
                return  # Opt-in; the SSH fetch key cannot write API statuses.
            if not re.fullmatch(r"[A-Za-z0-9_-]{1,256}", token):
                raise ValueError("invalid_github_token")
            # Coalesce outages to the latest lifecycle evidence per SHA. A
            # fetch failure must not overwrite a candidate's deployment result.
            events = self.store.db.execute("""
                SELECT revision,status FROM events WHERE sequence IN (
                  SELECT MAX(sequence) FROM events WHERE status!='fetch_failed'
                  GROUP BY revision
                ) ORDER BY sequence DESC
            """).fetchall()
            sent = 0
            for event in events:
                commit = revision(event["revision"])
                payload = self.report(commit)
                fingerprint = hashlib.sha256(json.dumps(payload).encode()).hexdigest()
                run_key = "github-check:" + commit
                output_key = "github-check-output:" + commit
                cached = self.store.get(run_key)
                run = json.loads(cached) if cached else None
                if not run or self.store.get(output_key) != fingerprint:
                    created = False
                    if not run:
                        # Recover an accepted create whose response/SQLite acknowledgement
                        # was lost instead of creating another check on every retry.
                        found = self.request(
                            token,
                            "GET",
                            f"commits/{commit}/check-runs?check_name=june%2Fdeploy&filter=latest&per_page=100",
                        )
                        run = next(
                            (
                                item
                                for item in found["check_runs"]
                                if item["head_sha"] == commit
                                and item["external_id"] == "june/deploy:" + commit
                            ),
                            None,
                        )
                        if not run:
                            run = self.request(
                                token,
                                "POST",
                                "check-runs",
                                {
                                    **payload,
                                    "head_sha": commit,
                                    "external_id": "june/deploy:" + commit,
                                },
                            )
                            created = True
                        if (
                            type(run["id"]) is not int
                            or run["id"] <= 0
                            or not re.fullmatch(
                                r"https://github\.com/lordbagel42/agent/runs/[0-9]+(?:\?check_suite_focus=true)?",
                                run["html_url"],
                            )
                        ):
                            raise ValueError("invalid_github_check")
                        run = {"id": run["id"], "html_url": run["html_url"]}
                        self.store.set(run_key, json.dumps(run))
                    if not created:
                        self.request(token, "PATCH", f"check-runs/{run['id']}", payload)
                    self.store.set(output_key, fingerprint)
                    sent += 1
                    if sent >= 10:
                        break
                # Migrate existing status Details links; new commits use only the
                # native check, avoiding two parallel entries for every deployment.
                key = "github-status:" + commit
                if self.store.get(key):
                    state = (
                        "pending"
                        if payload["status"] != "completed"
                        else {
                            "success": "success",
                            "failure": "failure",
                            "skipped": "error",
                            "action_required": "error",
                        }[payload["conclusion"]]
                    )
                    legacy = {
                        "state": state,
                        "context": "june/deploy",
                        "description": f"Deployment {state}; open Details",
                        "target_url": run["html_url"],
                    }
                    if self.store.get(key) != json.dumps(legacy):
                        self.request(token, "POST", f"statuses/{commit}", legacy)
                        self.store.set(key, json.dumps(legacy))
                        sent += 1
                if sent >= 10:
                    break  # Bound backfill work; newer evidence is sent first.
        except Exception:  # noqa: BLE001 - API bodies/credentials never reach logs or June
            self.retry_at = time.monotonic() + 60
            print("github_status_publish_failed: will retry", flush=True)


class Host:
    def __init__(self, config):
        self.config = config
        self.root = Path("/opt/june")
        self.releases = self.root / "releases"
        self.current = self.root / "current"
        self.stage_root = self.root / "build"
        self.repo = Path("/var/lib/june-deploy/source.git")
        self.token = private_file(Path("/etc/june/deploy-token")).strip()
        if not re.fullmatch(r"[A-Za-z0-9_-]{32,256}", self.token):
            raise ValueError("invalid_token")
        self.env = {
            "PATH": "/usr/bin:/bin",
            "HOME": "/var/lib/june-deploy",
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": "/dev/null",
            "GIT_TERMINAL_PROMPT": "0",
            "GIT_SSH_COMMAND": "ssh -F /dev/null -i /etc/june/deploy-key -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/etc/june/deploy-known-hosts",
        }

    def git(self, *args, binary=False):
        result = subprocess.run(
            [
                "git",
                "-c",
                "core.hooksPath=/dev/null",
                "-c",
                "core.fsmonitor=false",
                "-C",
                str(self.repo),
                *args,
            ],
            env=self.env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            check=True,
            timeout=60,
        )
        return result.stdout if binary else result.stdout.decode().strip()

    def fetch(self):
        self.git("fetch", "--no-tags", REPOSITORY, "+refs/heads/main:refs/heads/main")
        return self.git("rev-parse", "refs/heads/main^{commit}")

    def committed_at(self, commit):
        return int(self.git("show", "-s", "--format=%ct", revision(commit))) * 1000

    def stage_record(self, stage):
        return self.stage_root / f".{stage.name}.json"

    def read_stage_record(self, stage):
        fd = os.open(
            self.stage_record(stage), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
        )
        with os.fdopen(fd) as file:
            meta = os.fstat(file.fileno())
            if (
                not stat.S_ISREG(meta.st_mode)
                or meta.st_uid != os.geteuid()
                or meta.st_mode & 0o077
                or meta.st_nlink != 1
                or meta.st_size > 4096
            ):
                raise ValueError("unsafe_stage_record")
            record = json.load(file)
        if (
            record.get("version") != 1
            or any(
                type(record.get(key)) is not int or record[key] < 0
                for key in ("device", "inode", "launcherPid")
            )
            or record["launcherPid"] > 2**31 - 1
            or type(record.get("launchSettled")) is not bool
            or not isinstance(record.get("bootId"), str)
            or not re.fullmatch(r"[0-9a-f-]{36}", record["bootId"])
        ):
            raise ValueError("invalid_stage_record")
        return record

    def build_unit_stopped(self, stage):
        result = subprocess.check_output(
            [
                "systemctl",
                "show",
                "--all",
                "--property=LoadState,ActiveState,SubState,MainPID,ControlPID,Job,ControlGroup",
                f"june-build-{stage.name}.service",
            ],
            stderr=subprocess.DEVNULL,
            timeout=5,
        ).decode()
        properties = dict(line.split("=", 1) for line in result.splitlines())
        # Empty ControlGroup is required as well as zero main/control PIDs:
        # neither an exited main process nor a failed unit proves child exit.
        return (
            properties.get("LoadState") in ("loaded", "not-found")
            and (properties.get("ActiveState"), properties.get("SubState"))
            in (("inactive", "dead"), ("failed", "failed"))
            and all(properties.get(key) == "0" for key in ("MainPID", "ControlPID"))
            and all(properties.get(key) == "" for key in ("Job", "ControlGroup"))
        )

    def recover_stages(self):
        # Call only under deployment_lock, including the normal polling loop.
        # Names alone never authorize deletion; old/unregistered stages stay put.
        removed = 0
        for path in sorted(self.stage_root.glob(".stage-*.json")):
            name = path.name[1:-5]
            if STAGE.fullmatch(name) and self.remove_stage(self.stage_root / name):
                removed += 1
        return removed

    def remove_stage(self, stage):
        try:
            record = self.read_stage_record(stage)
            if record["launcherPid"]:
                if (
                    record["bootId"]
                    == Path("/proc/sys/kernel/random/boot_id").read_text().strip()
                ):
                    try:
                        os.kill(record["launcherPid"], 0)
                    except ProcessLookupError:
                        pass
                    else:
                        return  # Also conservative when a PID has been reused.
                    if not record["launchSettled"]:
                        # A dead client and absent unit do not acknowledge a
                        # possibly queued manager request. Retain the ambiguity.
                        return
                if not self.build_unit_stopped(stage):
                    return
            removed = False
            try:
                meta = stage.lstat()
            except FileNotFoundError:
                pass  # Promotion or a previously interrupted removal completed.
            else:
                if (
                    not stat.S_ISDIR(meta.st_mode)
                    or stage.resolve() != stage
                    or (meta.st_dev, meta.st_ino) != (record["device"], record["inode"])
                    or stage == self.current.resolve()
                    or os.path.lexists(stage / ".june-release.json")
                ):
                    return
                shutil.rmtree(stage)
                sync_directory(self.stage_root)
                removed = True
            self.stage_record(stage).unlink()
            sync_directory(self.stage_root)
            return removed
        except (
            OSError,
            ValueError,
            TypeError,
            AttributeError,
            subprocess.SubprocessError,
        ):
            # Unknown identity, manager failure or partial removal: keep evidence
            # and retry on a later tick, never guess or stop an active build.
            return

    def prune(self, commits):
        # Only SQLite-recorded obsolete controller releases reach this method.
        # Legacy/unregistered paths, cache, backups and all June data are untouched.
        for commit in sorted(commits):
            release = self.releases / revision(commit)
            trash = self.releases / f".prune-{commit}"
            if self.current.resolve() in (release, trash):
                continue
            for path in (trash, release):
                try:
                    meta = path.lstat()
                except FileNotFoundError:
                    continue
                if (
                    path.resolve() != path
                    or not stat.S_ISDIR(meta.st_mode)
                    or meta.st_uid != os.geteuid()
                    or meta.st_mode & 0o022
                ):
                    raise ValueError("unsafe_retired_release")
                if path == release:
                    marker_path = path / ".june-release.json"
                    meta = marker_path.lstat()
                    if (
                        not stat.S_ISREG(meta.st_mode)
                        or meta.st_uid != os.geteuid()
                        or meta.st_mode & 0o022
                        or meta.st_size > 4096
                    ):
                        raise ValueError("unsafe_retired_marker")
                    marker = json.loads(marker_path.read_text())
                    if marker.get("revision") != commit or any(
                        not isinstance(marker.get(key), str)
                        or not HASH.fullmatch(marker[key])
                        for key in ("compatibility", "binding", "artifactSha256")
                    ):
                        raise ValueError("invalid_retired_marker")
                    # Rename first: a crash during recursive removal must leave
                    # recognisable disposable trash, not a broken retained release.
                    os.rename(release, trash)
                    sync_directory(self.releases)
                shutil.rmtree(trash)
                sync_directory(self.releases)

    def require_space(self, commit):
        # Current pinned dependencies occupy about 2.3 GiB. Admission leaves
        # margin for source/cache growth; check the reserve again after building.
        minimum = (1 if (self.releases / revision(commit)).exists() else 4) * 1024**3
        if shutil.disk_usage(self.stage_root).free < minimum:
            raise InsufficientDisk()

    def prepare(self, commit):
        release = self.releases / revision(commit)
        self.require_space(commit)
        if release.exists():
            return self.manifest(commit)
        # All non-test source except the pure HTML view is conservatively bound.
        entries = self.git(
            "ls-tree", "-r", "-z", commit, "--", *SOURCE, binary=True
        ).split(b"\0")
        entries = [entry for entry in entries if entry]
        names = [entry.split(b"\t", 1)[1].decode() for entry in entries]
        tree = b"\0".join(
            entry
            for entry, name in zip(entries, names)
            if name != "src/console/view.ts" and not name.endswith(".test.ts")
        )
        compatibility = hashlib.sha256(tree).hexdigest()
        archive = self.git(
            "archive",
            "--format=tar",
            commit,
            "--",
            *sorted({name.split("/")[0] for name in names}),
            binary=True,
        )
        if len(archive) > 64 * 1024 * 1024:
            raise ValueError("source_too_large")
        stage = Path(tempfile.mkdtemp(prefix="stage-", dir=self.stage_root))
        if os.path.lexists(self.stage_record(stage)):
            # Never reuse a name with outstanding evidence, even if its previous
            # directory disappeared. Only this newly created empty dir is ours.
            stage.rmdir()
            raise ValueError("stage_record_exists")
        try:
            meta = stage.stat()
            # Outside the builder-writable tree; durable before extraction or
            # launch. A crash before this write leaves only an unknown empty dir.
            atomic_json(
                self.stage_record(stage),
                {
                    "version": 1,
                    "device": meta.st_dev,
                    "inode": meta.st_ino,
                    "launcherPid": 0,
                    "launchSettled": False,
                    "bootId": Path("/proc/sys/kernel/random/boot_id")
                    .read_text()
                    .strip(),
                },
            )
            with tarfile.open(fileobj=io.BytesIO(archive)) as source:
                members = source.getmembers()
                if len(members) > 10_000:
                    raise ValueError("too_many_files")
                for member in members:
                    parts = PurePosixPath(member.name).parts
                    if (
                        not parts
                        or member.name.startswith("/")
                        or ".." in parts
                        or "\\" in member.name
                        or parts[0] not in SOURCE
                        or not (member.isfile() or member.isdir())
                        or any(
                            p.startswith(".env")
                            or p in (".git", "node_modules", ".data", ".codex")
                            for p in parts
                        )
                    ):
                        raise ValueError("unsafe_source")
                source.extractall(stage, filter="data")
            if (
                json.loads((stage / "package.json").read_text())["packageManager"]
                != "pnpm@10.33.0"
            ):
                raise ValueError("unexpected_package_manager")
            self.build(stage)
            if shutil.disk_usage(self.stage_root).free < 1024**3:
                raise InsufficientDisk()
            self.seal(stage)
            marker = {
                "revision": commit,
                "compatibility": compatibility,
                "binding": self.binding(),
                "artifactSha256": tree_digest(stage),
            }
            atomic_json(stage / ".june-release.json", marker, 0o644)
            os.rename(stage, release)
            sync_directory(self.releases)
            return marker
        finally:
            self.remove_stage(stage)

    def run_build(self, stage, command):
        # The child cannot contact systemd before its PID is durable. If the
        # controller dies before releasing the gate, EOF prevents any launch.
        # exec keeps that PID until systemd-run exits, including delayed starts.
        with subprocess.Popen(
            [
                sys.executable,
                "-I",
                "-c",
                (
                    "import os, sys; "
                    "sys.exit(1) if os.read(0, 1) != b'1' else None; "
                    "os.dup2(os.open(os.devnull, os.O_RDONLY), 0); "
                    "os.execvp(sys.argv[1], sys.argv[1:])"
                ),
                *command,
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        ) as launcher:
            try:
                record = self.read_stage_record(stage)
                record["launcherPid"] = launcher.pid
                atomic_json(self.stage_record(stage), record)
                launcher.stdin.write(b"1")
                launcher.stdin.flush()
            finally:
                launcher.stdin.close()
            if launcher.wait() != 0:
                raise ValueError("build_failed")
            # Only a successful --wait is manager settlement evidence. A signal,
            # failure or lost response may leave an unacknowledged start request.
            record["launchSettled"] = True
            atomic_json(self.stage_record(stage), record)

    def build(self, stage):
        builder = pwd.getpwnam("june-build")
        if builder.pw_uid in (0, pwd.getpwnam("june").pw_uid):
            raise ValueError("unsafe_builder")
        for path in [stage, *stage.rglob("*")]:
            os.chown(path, builder.pw_uid, builder.pw_gid)
        unit = "june-build-" + stage.name
        # An independent cgroup reaps ALL build children before we seal files.
        # Candidate code sees neither fetch/operator credentials nor June data.
        self.run_build(
            stage,
            [
                "systemd-run",
                "--quiet",
                "--wait",
                "--pipe",
                "--collect",
                f"--unit={unit}",
                "--service-type=exec",
                "-p",
                "User=june-build",
                "-p",
                "Group=june-build",
                "-p",
                f"WorkingDirectory={stage}",
                "-p",
                "KillMode=control-group",
                "-p",
                "RuntimeMaxSec=180",
                "-p",
                "NoNewPrivileges=yes",
                "-p",
                "ProtectSystem=strict",
                "-p",
                "ProtectHome=yes",
                "-p",
                "PrivateTmp=yes",
                "-p",
                "InaccessiblePaths=/etc/june /var/lib/june /var/lib/june-deploy",
                "-p",
                f"ReadWritePaths={stage} /var/cache/june-build",
                "/usr/bin/env",
                "-i",
                "HOME=/var/cache/june-build",
                "PATH=/opt/node-v24.21.0/bin:/usr/bin:/bin",
                "CI=1",
                "COREPACK_HOME=/opt/june/corepack",
                "COREPACK_ENABLE_NETWORK=0",
                "/bin/sh",
                "/usr/local/lib/june-deploy/preflight.sh",
            ],
        )

    def seal(self, stage):
        for path in [stage, *stage.rglob("*")]:
            meta = path.lstat()
            if path.is_symlink():
                if not path.resolve().is_relative_to(stage):
                    raise ValueError("escaping_dependency_link")
                os.chown(path, os.geteuid(), os.getegid(), follow_symlinks=False)
            else:
                if not (stat.S_ISREG(meta.st_mode) or stat.S_ISDIR(meta.st_mode)) or (
                    path.is_file() and meta.st_nlink != 1
                ):
                    raise ValueError("unsafe_dependency")
                os.chown(path, os.geteuid(), os.getegid())
                os.chmod(
                    path, 0o755 if path.is_dir() or meta.st_mode & 0o111 else 0o644
                )
        # The build cgroup has settled. Flush this filesystem once after sealing
        # all data/metadata, not one journal commit per dependency file. The
        # marker and promotion directory are still fsynced separately afterwards.
        subprocess.run(["sync", "--file-system", str(stage)], check=True)

    def binding(self):
        # Includes config, unit's namespace/state/env references, and pinned Node.
        digest = hashlib.sha256()
        for name in (
            "/etc/june/config.json",
            "/opt/node-v24.21.0/.june-node-sha256",
        ):
            digest.update(Path(name).read_bytes())
        # Include drop-ins; hashing only the original unit misses state/env changes.
        digest.update(
            subprocess.check_output(
                ["systemctl", "cat", "june.service"],
                stderr=subprocess.DEVNULL,
                timeout=5,
            )
        )
        return digest.hexdigest()

    def manifest(self, commit):
        release = self.releases / revision(commit)
        if release.is_symlink() or not release.is_dir():
            raise ValueError("invalid_release")
        marker = json.loads((release / ".june-release.json").read_text())
        if (
            marker["revision"] != commit
            or any(
                not HASH.fullmatch(marker[k])
                for k in ("compatibility", "binding", "artifactSha256")
            )
            or tree_digest(release) != marker["artifactSha256"]
        ):
            raise ValueError("changed_release")
        return marker

    def rollback_safe(self, before, after):
        if before["binding"] != self.binding() or after["binding"] != before["binding"]:
            raise ValueError("runtime_binding_changed")
        if before["compatibility"] == after["compatibility"]:
            return True
        return any(
            item
            == {
                "from": before["revision"],
                "to": after["revision"],
                "binding": before["binding"],
                "rollbackSafe": True,
            }
            for item in self.config["transitions"]
        )

    def request(self, path, method="GET"):
        opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}), NoRedirect()
        )
        headers = {"Authorization": f"Bearer {self.token}"} if method != "GET" else {}
        try:
            with opener.open(
                urllib.request.Request(
                    self.config["origin"] + path, method=method, headers=headers
                ),
                timeout=5,
            ) as response:
                return json.loads(response.read(4096))
        except urllib.error.HTTPError as error:
            error.close()
            raise ValueError("http_failed") from None

    def healthy(self, commit):
        end = time.monotonic() + self.config["healthSeconds"]
        while time.monotonic() < end:
            try:
                body = self.request("/health")
                if (
                    body.get("name") == "June"
                    and body.get("ready") is True
                    and body.get("revision") == commit
                    and self.running(commit)
                ):
                    return True
            except Exception:  # noqa: BLE001,S110 - untrusted HTTP/error bodies never enter logs
                pass
            time.sleep(0.1)
        return False

    def drain(self, commit):
        body = self.request("/operator/deployment/drain", "POST")
        return (
            body.get("revision") == commit
            and body.get("drained") is True
            and self.running(commit)
        )

    def resume(self, commit):
        body = self.request("/operator/deployment/drain", "DELETE")
        return body.get("revision") == commit and body.get("drained") is False

    def running(self, commit):
        pid = (
            subprocess.check_output(
                ["systemctl", "show", "--property=MainPID", "--value", "june.service"],
                stderr=subprocess.DEVNULL,
                timeout=5,
            )
            .decode()
            .strip()
        )
        return (
            pid.isdecimal()
            and pid != "0"
            and Path(f"/proc/{pid}/cwd").resolve() == self.releases / commit
        )

    def settled(self):
        jobs = subprocess.check_output(
            ["systemctl", "list-jobs", "--no-legend", "--no-pager"],
            stderr=subprocess.DEVNULL,
            timeout=5,
        ).decode()
        return not any("june.service" in row.split() for row in jobs.splitlines())

    def service(self, action):
        if action not in ("stop", "start"):
            raise ValueError("invalid_action")
        # No subprocess timeout: systemd owns stop timeout/cgroup settlement.
        # A failed/unknown manager operation blocks, never invokes another one.
        subprocess.run(
            ["systemctl", action, "june.service"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=True,
        )

    def switch(self, commit):
        link = self.current.with_name(".current-deploy")
        link.unlink(missing_ok=True)
        link.symlink_to(self.releases / revision(commit))
        os.replace(link, self.current)
        sync_directory(self.current.parent)


def tree_digest(root):
    digest = hashlib.sha256()
    for file in [root, *sorted(root.rglob("*"))]:
        meta = file.lstat()
        if meta.st_uid != os.geteuid() or (
            not file.is_symlink() and meta.st_mode & 0o022
        ):
            raise ValueError("mutable_artifact")
        if file.is_symlink() and not file.resolve().is_relative_to(root):
            raise ValueError("escaping_artifact_link")
        if file == root:
            continue
        if file.name == ".june-release.json" and file.parent == root:
            continue
        digest.update(str(file.relative_to(root)).encode() + b"\0")
        if file.is_symlink():
            digest.update(b"link\0" + os.readlink(file).encode())
        elif file.is_file():
            digest.update(b"file\0" + str(file.stat().st_mode & 0o777).encode() + b"\0")
            with file.open("rb") as content:
                for chunk in iter(lambda: content.read(1024 * 1024), b""):
                    digest.update(chunk)
        elif not file.is_dir():
            raise ValueError("unsafe_artifact")
        digest.update(b"\0")
    return digest.hexdigest()


def installed_controller_revision(provenance):
    """Operator installation record, never app/main identity. Read once at startup."""
    if not isinstance(provenance, dict) or set(provenance) != {"revision", "digest"}:
        return None
    try:
        commit = revision(provenance["revision"])
        root = Path(__file__).parent
        if (
            root.resolve() != root
            or not isinstance(provenance["digest"], str)
            or not HASH.fullmatch(provenance["digest"])
            or tree_digest(root) != provenance["digest"]
        ):
            return None
        return commit
    except (OSError, ValueError):
        # Missing, changed or mutable installation is unknown, not an app SHA
        # fallback or a reason to interrupt otherwise safe deployment observation.
        return None


def private_file(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd) as file:
        metadata = os.fstat(file.fileno())
        if (
            metadata.st_uid != 0
            or metadata.st_mode & 0o077
            or metadata.st_nlink != 1
            or not stat.S_ISREG(metadata.st_mode)
        ):
            raise ValueError("private_root_file_required")
        return file.read()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--once", action="store_true")
    mode.add_argument("--prepare", metavar="REVISION")
    mode.add_argument("--bootstrap", action="store_true")
    mode.add_argument("--reconcile", metavar="REVISION")
    args = parser.parse_args()
    os.umask(0o077)
    if os.geteuid() != 0:
        raise ValueError("root_required")
    config = json.loads(private_file(Path("/etc/june/deploy.json")))
    if (
        not re.fullmatch(
            r"http://(?:127\.0\.0\.1|192\.168\.0\.215):[0-9]{1,5}", config["origin"]
        )
        or not 1 <= config["healthSeconds"] <= 120
    ):
        raise ValueError("invalid_config")
    # Administrator pre-creates these canonical root-owned paths; never repair
    # unexpected ownership or adopt an existing untrusted deployment database.
    for name in (
        "/opt/june",
        "/opt/june/build",
        "/opt/june/releases",
        "/var/lib/june-deploy",
        "/var/lib/june-deploy/public",
    ):
        path = Path(name)
        meta = path.lstat()
        if (
            path.resolve() != path
            or not path.is_dir()
            or meta.st_uid != 0
            or meta.st_mode & 0o022
        ):
            raise ValueError("unsafe_installation")
    with deployment_lock("/var/lib/june-deploy/deploy.lock"):
        host = Host(config)
        recovered = host.recover_stages()
        if args.prepare:
            if revision(args.prepare) != revision(host.fetch()):
                raise ValueError("not_current_main")
            host.prepare(args.prepare)
            return
        initial = revision(config["initialRevision"])
        database = Path("/var/lib/june-deploy/records")
        exists = (database / "deploy.sqlite").exists()
        if args.bootstrap:
            if exists or not host.healthy(initial):
                raise ValueError("bootstrap_not_healthy_or_already_exists")
        elif not exists:
            raise ValueError("missing_deployment_records")
        host.manifest(initial)
        store = Store(
            database,
            Path("/var/lib/june-deploy/public/events.json"),
            initial,
            pwd.getpwnam("june").pw_gid,
            controller_revision=installed_controller_revision(config.get("controller")),
            staging_recovery_feed=config.get("stagingRecoveryFeed") is True,
        )
        statuses = GitHubStatuses(store)
        loop = Deployer(host, store, statuses)
        try:
            store.stage_recovery(recovered)
            if args.bootstrap:
                store.event(initial, "healthy")
                return
            if args.reconcile:
                loop.reconcile(args.reconcile)
                return
            while True:
                loop.tick()
                if args.once:
                    break
                time.sleep(5)
        finally:
            statuses.flush()
            store.close()


if __name__ == "__main__":
    try:
        main()
    except Exception:  # noqa: BLE001 - final credential-redaction boundary
        # No tracebacks: subprocess arguments, URLs or errors may hold secrets.
        raise SystemExit(
            "june_deploy_stopped: inspect protected state and installation"
        ) from None
