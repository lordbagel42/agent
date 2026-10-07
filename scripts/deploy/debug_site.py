#!/usr/bin/env python3
"""Independent trusted-main updates. Install this policy; never execute it from main."""

import argparse
import fcntl
import hashlib
import io
import json
import os
import pwd
import re
import shutil
import stat
import subprocess
import tarfile
import tempfile
import time
import urllib.request
from pathlib import Path

ROOT = Path("/opt/june-debug")
STATE = Path("/var/lib/june-debug-deploy")
POLICY = Path("/usr/local/lib/june-debug-deploy")
UNIT = "june-debug-site.service"
CGROUP = Path("/sys/fs/cgroup")
HEALTH_URL = "http://127.0.0.1:3092/health"
REPOSITORY = "https://github.com/lordbagel42/agent.git"
INPUTS = (
    "src",
    "debug-site",
    "scripts/build-debug-site.ts",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    ".npmrc",
    "biome.json",
    "tsconfig.json",
)
STORAGE = (
    "src/diagnostics/store.ts",
    "src/diagnostics/operations.ts",
    "src/diagnostics/issue-tracker.ts",
)


class Interrupted(RuntimeError):
    """An external effect did not acknowledge settlement; do not retry it."""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


def revision(value):
    if not isinstance(value, str) or not re.fullmatch("[0-9a-f]{40}", value):
        raise ValueError("invalid_revision")
    return value


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
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


def trusted_json(path):
    if path.resolve() != path:
        raise ValueError("unsafe_policy_path")
    meta = path.lstat()
    if (
        not stat.S_ISREG(meta.st_mode)
        or meta.st_uid != 0
        or meta.st_mode & 0o022
        or meta.st_nlink != 1
        or meta.st_size > 16384
    ):
        raise ValueError("unsafe_policy_file")
    return json.loads(path.read_text())


def bundle_digest(root, trusted=False):
    digest = hashlib.sha256()
    for path in sorted([root, *root.rglob("*")]):
        meta = path.lstat()
        if not (stat.S_ISDIR(meta.st_mode) or stat.S_ISREG(meta.st_mode)):
            raise ValueError("unsafe_bundle_entry")
        if trusted and (meta.st_uid != 0 or meta.st_mode & 0o022):
            raise ValueError("mutable_bundle")
        if stat.S_ISREG(meta.st_mode):
            if meta.st_nlink != 1 or meta.st_size > 64 * 1024 * 1024:
                raise ValueError("unsafe_bundle_file")
            if path == root / ".june-debug-release.json":
                continue
            digest.update(str(path.relative_to(root)).encode() + b"\0")
            digest.update(hashlib.sha256(path.read_bytes()).digest())
    return digest.hexdigest()


def run_once(host, state, save):
    def record(phase, reason=None):
        state.update(phase=phase, reason=reason, checkedAt=int(time.time() * 1000))
        save(state)

    if state["phase"] in ("building", "activating", "blocked"):
        record("blocked", state.get("reason") or "interrupted")
        return
    if not host.enabled:
        record("disabled")
        return
    previous = state["activeRevision"]
    try:
        if host.current() != previous:
            raise ValueError("identity_drift")
    except Exception:
        record("blocked", "current_unhealthy")
        return
    try:
        target = revision(host.fetch())
    except Exception:
        record("failed", "fetch_failed")
        return
    if not host.ancestor(state["lastSeenRevision"], target):
        record("blocked", "non_fast_forward")
        return
    state.update(lastSeenRevision=target, targetRevision=target)
    if target == state.get("failedRevision"):
        record("failed", state["failedReason"])
        return
    if not host.storage_allowed(target):
        record("blocked", "storage_policy_changed")
        return
    if target == previous or host.unchanged(previous, target):
        record("ready", None if target == previous else "source_unchanged")
        return
    binding = host.binding()
    record("building")
    try:
        host.prepare(target)
    except Interrupted:
        record("blocked", "interrupted")
        return
    except Exception:
        state.update(failedRevision=target, failedReason="preflight_failed")
        record("failed", "preflight_failed")
        return
    if host.binding() != binding:
        record("blocked", "binding_changed")
        return
    record("activating")
    try:
        host.activate(target)
        if host.current() != target:
            raise ValueError("identity_mismatch")
    except Interrupted:
        record("blocked", "interrupted")
        return
    except Exception:
        if host.binding() != binding:
            record("blocked", "binding_changed")
            return
        try:
            host.activate(previous)
            if host.current() != previous:
                raise ValueError("rollback_identity_mismatch")
        except Exception:
            record("blocked", "rollback_unhealthy")
            return
        state.update(failedRevision=target, failedReason="health_failed")
        record("failed", "health_failed")
        return
    state.update(activeRevision=target, failedRevision=None, failedReason=None)
    record("ready")


class Host:
    def __init__(self, config):
        self.enabled = config["enabled"]
        self.storage = config["storagePins"]
        if not isinstance(self.enabled, bool) or set(self.storage) != set(STORAGE):
            raise ValueError("invalid_policy")
        for value in self.storage.values():
            if value is not None:
                revision(value)
        self.repository = STATE / "source.git"

    def command(self, *args, timeout=120):
        return subprocess.run(
            args,
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=timeout,
        ).stdout

    def git(self, *args):
        # Public repository: no credential helpers, private environment or redirects.
        return subprocess.run(
            [
                "git",
                "-c",
                "credential.helper=",
                "-c",
                "http.followRedirects=false",
                "--git-dir",
                str(self.repository),
                *args,
            ],
            env={
                "PATH": "/usr/bin:/bin",
                "HOME": "/nonexistent",
                "GIT_CONFIG_NOSYSTEM": "1",
                "GIT_CONFIG_GLOBAL": "/dev/null",
                "GIT_TERMINAL_PROMPT": "0",
            },
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=120,
        ).stdout

    def fetch(self):
        self.git("fetch", "--no-tags", REPOSITORY, "+refs/heads/main:refs/heads/main")
        return revision(self.git("rev-parse", "refs/heads/main").decode().strip())

    def ancestor(self, previous, target):
        try:
            self.git(
                "merge-base", "--is-ancestor", revision(previous), revision(target)
            )
            return True
        except subprocess.CalledProcessError as error:
            if error.returncode == 1:
                return False
            raise

    def unchanged(self, previous, target):
        return self.git("ls-tree", "-r", revision(previous), "--", *INPUTS) == self.git(
            "ls-tree", "-r", revision(target), "--", *INPUTS
        )

    def storage_allowed(self, commit):
        for path, expected in self.storage.items():
            entry = self.git("ls-tree", revision(commit), "--", path).decode().strip()
            actual = entry.split()[2] if entry else None
            if actual != expected:
                return False
        return True

    def binding(self):
        digest = hashlib.sha256(Path("/etc/june-debug/site.env").read_bytes())
        digest.update(self.command("systemctl", "cat", UNIT))
        return digest.hexdigest()

    def assert_settled(self, unit):
        try:
            properties = dict(
                line.split("=", 1)
                for line in self.command(
                    "systemctl",
                    "show",
                    unit,
                    "-p",
                    "ActiveState",
                    "-p",
                    "MainPID",
                    "-p",
                    "ControlPID",
                    "-p",
                    "Job",
                    "-p",
                    "ControlGroup",
                )
                .decode()
                .splitlines()
            )
            if (
                properties["ActiveState"] not in ("inactive", "failed")
                or properties["MainPID"] != "0"
                or properties["ControlPID"] != "0"
                or properties["Job"]
            ):
                raise Interrupted()
            # Tracked PIDs may be zero even when descendants survived SIGKILL.
            # All our units use system.slice. The expected cgroup must either
            # be empty recursively, or already removed after collection.
            if (
                not (CGROUP / "cgroup.controllers").is_file()
                or not (CGROUP / "system.slice").is_dir()
            ):
                raise Interrupted()
            expected = f"/system.slice/{unit}"
            if properties.get("ControlGroup") not in (None, "", expected):
                raise Interrupted()
            group = CGROUP / expected.lstrip("/")
            try:
                events = dict(
                    line.split()
                    for line in (group / "cgroup.events").read_text().splitlines()
                )
                if events["populated"] != "0":
                    raise Interrupted()
            except FileNotFoundError:
                if group.exists():
                    raise Interrupted()
        except Exception as error:
            raise Interrupted() from error

    def verify(self, commit):
        release = ROOT / "releases" / revision(commit)
        if release.resolve() != release:
            raise ValueError("unsafe_release_path")
        marker = trusted_json(release / ".june-debug-release.json")
        if marker != {
            "revision": commit,
            "storagePins": self.storage,
            "sha256": bundle_digest(release, trusted=True),
        }:
            raise ValueError("release_integrity_failed")
        return release

    def identity(self):
        identity = dict(
            line.split("=", 1)
            for line in self.command(
                "systemctl",
                "show",
                UNIT,
                "-p",
                "MainPID",
                "-p",
                "InvocationID",
                "-p",
                "ActiveState",
                "-p",
                "SubState",
            )
            .decode()
            .splitlines()
        )
        if (
            identity["ActiveState"] != "active"
            or identity["SubState"] != "running"
            or not identity["MainPID"].isdigit()
            or int(identity["MainPID"]) == 0
            or not re.fullmatch("[0-9a-f]{32}", identity["InvocationID"])
        ):
            raise ValueError("process_not_running")
        return identity

    def health(self):
        opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}), NoRedirect()
        )
        with opener.open(HEALTH_URL, timeout=3) as response:
            return json.loads(response.read(16385))

    def current(self):
        path = (ROOT / "current").resolve(strict=True)
        commit = revision(path.name)
        if self.verify(commit) != path:
            raise ValueError("unexpected_release")
        identity = self.identity()
        health = self.health()
        if (
            self.identity() != identity
            or health.get("ready") is not True
            or health.get("revision") != commit
        ):
            raise ValueError("readiness_or_identity_failed")
        return commit

    def wait_ready(self, commit):
        for _ in range(30):
            try:
                identity = self.identity()
                if self.current() == commit:
                    break
            except Exception:
                pass
            time.sleep(1)
        else:
            raise ValueError("readiness_failed")
        # First readiness is not stabilization. A changed process invocation,
        # failed probe or restart during this window fails the candidate.
        for _ in range(5):
            time.sleep(1)
            if self.current() != commit or self.identity() != identity:
                raise ValueError("readiness_unstable")

    def prepare(self, commit):
        release = ROOT / "releases" / revision(commit)
        if release.exists():
            self.verify(commit)
            return
        if shutil.disk_usage(ROOT).free < 3 * 1024**3:
            raise ValueError("insufficient_disk")
        stage = Path(tempfile.mkdtemp(prefix="stage-", dir=ROOT / "build"))
        archive = self.git("archive", commit)
        with tarfile.open(fileobj=io.BytesIO(archive)) as source:
            source.extractall(stage, filter="data")
        builder = pwd.getpwnam("june-debug-build")
        if builder.pw_uid in (0, pwd.getpwnam("june-debug").pw_uid):
            raise ValueError("unsafe_builder")
        for path in [stage, *stage.rglob("*")]:
            os.chown(path, builder.pw_uid, builder.pw_gid, follow_symlinks=False)
        properties = {
            "User": "june-debug-build",
            "Group": "june-debug-build",
            "WorkingDirectory": str(stage),
            "KillMode": "control-group",
            "RuntimeMaxSec": "900",
            "MemoryMax": "4G",
            "MemorySwapMax": "0",
            "OOMPolicy": "kill",
            "NoNewPrivileges": "yes",
            "ProtectSystem": "strict",
            "ProtectHome": "yes",
            "PrivateTmp": "yes",
            "PrivateDevices": "yes",
            "ProtectKernelTunables": "yes",
            "ProtectKernelModules": "yes",
            "ProtectControlGroups": "yes",
            "RestrictSUIDSGID": "yes",
            "UMask": "0077",
            "StandardOutput": "journal",
            "StandardError": "journal",
            "InaccessiblePaths": "/etc/june-debug /var/lib/june-debug /var/lib/june-debug-deploy",
            "ReadWritePaths": f"{stage} /var/cache/june-debug-build",
        }
        unit = f"june-debug-build-{stage.name}.service"
        command = [
            "systemd-run",
            "--quiet",
            "--wait",
            "--collect",
            f"--unit={unit}",
            "--slice=system.slice",
            "--service-type=exec",
        ]
        for key, value in properties.items():
            command.extend(["-p", f"{key}={value}"])
        command.extend(
            [
                "/usr/bin/env",
                "-i",
                "HOME=/var/cache/june-debug-build",
                "PATH=/opt/node-v24.21.0-linux-x64/bin:/usr/bin:/bin",
                "CI=1",
                "COREPACK_HOME=/opt/june-debug/corepack",
                "COREPACK_ENABLE_NETWORK=0",
                f"JUNE_DEBUG_BUILD_REVISION={commit}",
                "/bin/sh",
                str(POLICY / "debug-site-preflight.sh"),
            ]
        )
        try:
            result = subprocess.run(
                command,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=960,
            )
        except subprocess.TimeoutExpired as error:
            raise Interrupted() from error
        if result.returncode < 0:
            raise Interrupted()
        # A failed client/DBus call does not prove the build stopped. Never
        # promote or retry while that unit could still be writing its output.
        self.assert_settled(unit)
        if result.returncode != 0:
            # Retain failed staging for operator inspection; never delete uncertain children.
            raise ValueError("preflight_failed")
        output = stage / "dist/debug-site"
        expected = bundle_digest(output)
        if (
            not (output / "server.mjs").is_file()
            or not (output / "public/index.html").is_file()
        ):
            raise ValueError("missing_bundle")
        sealed = Path(tempfile.mkdtemp(prefix=".prepared-", dir=ROOT / "releases"))
        shutil.copytree(
            output, sealed, dirs_exist_ok=True, copy_function=shutil.copyfile
        )
        for path in [sealed, *sealed.rglob("*")]:
            path.chmod(0o755 if path.is_dir() else 0o644)
            if path.is_file():
                with path.open("rb") as file:
                    os.fsync(file.fileno())
        for path in sorted(sealed.rglob("*"), reverse=True):
            if path.is_dir():
                sync_directory(path)
        if bundle_digest(sealed, trusted=True) != expected:
            raise ValueError("bundle_changed")
        atomic_json(
            sealed / ".june-debug-release.json",
            {"revision": commit, "storagePins": self.storage, "sha256": expected},
            0o644,
        )
        os.rename(sealed, release)
        sync_directory(release.parent)
        shutil.rmtree(stage)

    def activate(self, commit):
        release = self.verify(commit)
        temporary = ROOT / ".current-deploy"
        temporary.symlink_to(release)
        os.replace(temporary, ROOT / "current")
        sync_directory(ROOT)
        try:
            result = subprocess.run(
                ["systemctl", "restart", UNIT],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=120,
            )
        except subprocess.TimeoutExpired as error:
            raise Interrupted() from error
        if result.returncode < 0:
            raise Interrupted()
        if result.returncode != 0:
            self.assert_settled(UNIT)
            raise ValueError("restart_failed")
        self.wait_ready(commit)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bootstrap", metavar="HEALTHY_REVISION")
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise ValueError("operator_required")
    os.umask(0o077)
    lock = os.open(
        "/run/lock/june-debug-install.lock",
        os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW,
        0o600,
    )
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return
    config = trusted_json(Path("/etc/june-debug/deploy.json"))
    provenance = trusted_json(POLICY / "manifest.json")
    controller = revision(provenance["revision"])
    for name in ("debug_site.py", "debug-site-preflight.sh"):
        if (
            hashlib.sha256((POLICY / name).read_bytes()).hexdigest()
            != provenance["sha256"][name]
        ):
            raise ValueError("controller_integrity_failed")
    host = Host(config)
    group = pwd.getpwnam("june-debug").pw_gid

    def save(state):
        state.update(version=1, controllerRevision=controller)
        atomic_json(STATE / "state.json", state)
        public = {
            key: state[key]
            for key in (
                "version",
                "controllerRevision",
                "phase",
                "checkedAt",
                "targetRevision",
                "activeRevision",
                "reason",
            )
        }
        atomic_json(STATE / "public/status.json", public, 0o640, group)

    if args.bootstrap:
        commit = revision(args.bootstrap)
        target = host.fetch()
        if not host.ancestor(commit, target) or not host.storage_allowed(commit):
            raise ValueError("untrusted_bootstrap")
        release = ROOT / "releases" / commit
        if (ROOT / "current").resolve() != release:
            raise ValueError("bootstrap_identity_mismatch")
        marker = release / ".june-debug-release.json"
        if not marker.exists():
            atomic_json(
                marker,
                {
                    "revision": commit,
                    "storagePins": host.storage,
                    "sha256": bundle_digest(release, trusted=True),
                },
                0o644,
            )
        if host.current() != commit:
            raise ValueError("bootstrap_unhealthy")
        save(
            {
                "phase": "ready",
                "activeRevision": commit,
                "targetRevision": commit,
                "lastSeenRevision": commit,
                "failedRevision": None,
                "failedReason": None,
                "reason": None,
                "checkedAt": int(time.time() * 1000),
            }
        )
    else:
        state = trusted_json(STATE / "state.json")
        for key in ("activeRevision", "lastSeenRevision", "targetRevision"):
            revision(state[key])
        if state["phase"] not in (
            "ready",
            "building",
            "activating",
            "failed",
            "blocked",
            "disabled",
        ):
            raise ValueError("invalid_state")
        run_once(host, state, save)
    print("june_debug_deploy_observed")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Never copy configuration, fetch errors, build output or response bodies into logs.
        raise SystemExit(
            "june_debug_deploy_failed; inspect protected state and build unit"
        ) from None
