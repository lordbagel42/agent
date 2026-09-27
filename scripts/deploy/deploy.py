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
import tarfile
import tempfile
import time
import urllib.error
import urllib.request
from contextlib import contextmanager
from pathlib import Path, PurePosixPath

REPOSITORY = "git@github.com:lordbagel42/agent.git"
SOURCE = (
    "src",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "tsconfig.json",
    "biome.json",
    ".npmrc",
    ".node-version",
)
SHA = re.compile(r"^[0-9a-f]{40}$")
HASH = re.compile(r"^[0-9a-f]{64}$")


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
    def __init__(self, root, feed, initial, feed_gid=None):
        self.feed, self.feed_gid = feed, feed_gid
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

    def event(self, commit, status, reason=None, committed_at=None):
        now = time.time_ns() // 1_000_000
        previous = self.db.execute(
            "SELECT status,reason FROM events WHERE revision=? ORDER BY sequence DESC LIMIT 1",
            (commit,),
        ).fetchone()
        if previous and tuple(previous) == (status, reason):
            return
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

    def publish(self):
        events = [
            dict(row)
            for row in self.db.execute(
                "SELECT * FROM events ORDER BY sequence DESC LIMIT 100"
            )
        ][::-1]
        atomic_json(
            self.feed,
            {
                "version": 1,
                "repository": "lordbagel42/agent",
                "branch": "main",
                "lastHealthyRevision": self.get("active"),
                "blocked": bool(self.get("blocked")),
                "events": events,
            },
            0o640,
            self.feed_gid,
        )


class Deployer:
    def __init__(self, host, store):
        self.host, self.store = host, store
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
        if head != before:
            try:
                h.git("merge-base", "--is-ancestor", before, head)
            except subprocess.CalledProcessError:
                s.event(head, "received", committed_at=h.committed_at(head))
                s.block(head, "non_fast_forward")
                return head
            commits = h.git("rev-list", "--reverse", f"{before}..{head}").splitlines()
            for commit in commits:
                s.event(commit, "received", committed_at=h.committed_at(commit))
                if commit != head:
                    s.event(commit, "superseded")
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
        h, s = self.host, self.store
        try:
            target = self.observe()
        except Exception:  # noqa: BLE001 - never log SSH/credential-helper errors
            s.event(s.get("observed"), "fetch_failed", "fetch_failed")
            return
        if (
            s.get("blocked")
            or target == s.get("active")
            or s.status(target) in ("healthy", "failed", "rolled_back", "superseded")
        ):
            return
        previous = s.get("active")
        try:
            s.event(target, "preparing")
            candidate = h.prepare(target)
            prior = h.manifest(previous)
            rollback_safe = h.rollback_safe(prior, candidate)
            if self.observe() != target or s.get("blocked"):
                s.event(target, "superseded")
                return
            if not h.healthy(previous):
                s.block(target, "current_unhealthy")
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
            # Refresh after a potentially slow drain. Never activate stale work.
            if self.observe() != target or s.get("blocked"):
                s.event(target, "superseded")
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


class Host:
    def __init__(self, config):
        self.config = config
        self.root = Path("/opt/june")
        self.releases = self.root / "releases"
        self.current = self.root / "current"
        self.stage_root = Path("/var/cache/june-build")
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

    def prepare(self, commit):
        release = self.releases / revision(commit)
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
        try:
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
            if stage.exists():
                shutil.rmtree(stage)

    def build(self, stage):
        builder = pwd.getpwnam("june-build")
        if builder.pw_uid in (0, pwd.getpwnam("june").pw_uid):
            raise ValueError("unsafe_builder")
        for path in [stage, *stage.rglob("*")]:
            os.chown(path, builder.pw_uid, builder.pw_gid)
        unit = "june-build-" + stage.name
        # An independent cgroup reaps ALL build children before we seal files.
        # Candidate code sees neither fetch/operator credentials nor June data.
        subprocess.run(
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
                "ReadWritePaths=/var/cache/june-build",
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
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=True,
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
                if path.is_file():
                    with path.open("rb") as file:
                        os.fsync(file.fileno())
                else:
                    sync_directory(path)

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
        )
        loop = Deployer(host, store)
        try:
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
            store.close()


if __name__ == "__main__":
    try:
        main()
    except Exception:  # noqa: BLE001 - final credential-redaction boundary
        # No tracebacks: subprocess arguments, URLs or errors may hold secrets.
        raise SystemExit(
            "june_deploy_stopped: inspect protected state and installation"
        ) from None
