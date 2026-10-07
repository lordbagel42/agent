#!/usr/bin/env python3
"""Explicit issue companion updates; install this policy, never run from a worktree.

Install companions.py and issues.py root-owned in /usr/local/lib/june-companions.
Run with --role worker on amp-runner, --role sources on June, and --revision SHA.
The exact reviewed revision must be current public main. --start opts into first
activation; later updates preserve running state. This command never enables a
unit at boot, changes credentials, updates its own policy, or restores data.
--reconcile only verifies the recorded target after an interrupted update.
Coordinate existing ownership and pause the relevant app updater before invoking;
this command takes the host's outer lock itself. See docs/debug-site.md.
"""

import argparse
import fcntl
import hashlib
import importlib.util
import json
import os
import sqlite3
import stat
import subprocess
import sys
import tempfile
import time
from contextlib import ExitStack, contextmanager
from pathlib import Path

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location(
    "issues", Path(__file__).with_name("issues.py")
)
issues = importlib.util.module_from_spec(spec)
spec.loader.exec_module(issues)

ROOT = Path("/opt/june-issues")
STATE = Path("/var/lib/june-companions")
UNITS = Path("/etc/systemd/system")
REPOSITORY = "https://github.com/lordbagel42/agent.git"
SERVICES = {"worker": "june-issues.service", "sources": "june-issue-sources.service"}
ENTRY = {"worker": "issues.py", "sources": "source_status.py"}
FILES = ("issues.py", "deploy.py", "source_status.py", *SERVICES.values())


def revision(value):
    if not issues.matches(issues.SHA, value):
        raise ValueError("invalid_revision")
    return value


def trusted(path, *, directory=False):
    info = path.lstat()
    if (
        path.resolve() != path
        or info.st_uid != os.geteuid()
        or info.st_mode & 0o022
        or not (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode))
        or (not directory and (info.st_nlink != 1 or info.st_size > 2_000_000))
    ):
        raise ValueError("unsafe_companion_path")
    # Protect every ancestor, not just the leaf that happens to be root-owned.
    for parent in path.parents:
        info = parent.stat()
        if info.st_uid not in (0, os.geteuid()) or info.st_mode & 0o022:
            raise ValueError("unsafe_companion_parent")
    return path


@contextmanager
def existing_lock(path):
    # /run/lock is not a private state directory. Check the existing file via
    # its descriptor, without creating, replacing or chmodding it or its parent.
    fd = os.open(path, os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "a") as lock:
        info = os.fstat(lock.fileno())
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != 0
            or info.st_mode & 0o077
            or info.st_nlink != 1
        ):
            raise ValueError("unsafe_host_lock")
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield


def directory(path, mode=0o755):
    path.mkdir(mode=mode, exist_ok=True)
    return trusted(path, directory=True)


def atomic(path, data, mode=0o600):
    fd, name = tempfile.mkstemp(prefix=".companion-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as file:
            file.write(data)
            os.fchmod(file.fileno(), mode)
            file.flush()
            os.fsync(file.fileno())
        os.replace(name, path)
        issues.sync_directory(path.parent)
    finally:
        Path(name).unlink(missing_ok=True)


def unit_bytes(release, role):
    raw = (release / SERVICES[role]).read_bytes()
    expected = f"ExecStart=/usr/bin/python3 -I /opt/june-issues/current/{ENTRY[role]}"
    expected += " worker" if role == "worker" else ""
    if raw.splitlines().count(expected.encode()) != 1:
        raise ValueError("invalid_unit_template")
    return raw.replace(
        expected.encode(),
        expected.replace("/opt/june-issues/current", str(release)).encode(),
    )


def assert_idle(config):
    # Called under exclusive maintenance admission. Even an unknown observer
    # must be settled before an updater can claim the worker was idle.
    if os.path.lexists(Path(config["stateDirectory"]) / "active.json"):
        raise ValueError("issue_claim_unsettled")


def update(host, state, target, save, *, start=False, reconcile=False):
    if state is not None and (
        not isinstance(state, dict)
        or set(state) != {"phase", "revision", "running"}
        or state["phase"] not in ("ready", "applying")
        or not issues.matches(issues.SHA, state["revision"])
        or type(state["running"]) is not bool
    ):
        raise ValueError("invalid_companion_state")
    if reconcile:
        if not state or state["phase"] != "applying" or state["revision"] != target:
            raise ValueError("no_matching_update")
        host.verify(target, state["running"])
    else:
        if state:
            if state["phase"] != "ready":
                raise ValueError("reconciliation_required")
            host.verify(state["revision"], state["running"])
            if state["revision"] == target and (not start or state["running"]):
                return
        elif host.active():
            raise ValueError("unmanaged_companion")
        host.prepare(target)
        running = start or (state["running"] if state is not None else False)
        if state is None:
            state = {}
        state.update(phase="applying", revision=target, running=running)
        save(state)  # Durable fence precedes all service and installation effects.
        host.stop()
        host.install(target)
        host.verify(target, False)  # Reject newly visible drop-ins before any start.
        if running:
            host.start()
        host.verify(target, running)
    state["phase"] = "ready"
    save(state)


class Host:
    def __init__(self, role, previous=None):
        self.role = role
        self.unit = SERVICES[role]
        self.previous = previous
        self.repository = STATE / "source.git"

    def command(self, *args):
        return subprocess.run(
            args,
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=120,
        ).stdout

    def git(self, *args):
        return subprocess.run(
            [
                "/usr/bin/git",
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

    def check_release(self, target):
        release = trusted(ROOT / "releases" / revision(target), directory=True)
        marker = json.loads(trusted(release / "manifest.json").read_bytes())
        actual = {
            name: hashlib.sha256(trusted(release / name).read_bytes()).hexdigest()
            for name in FILES
        }
        if {p.name for p in release.iterdir()} != {
            *FILES,
            "manifest.json",
        } or marker != {"revision": target, "sha256": actual}:
            raise ValueError("companion_release_drift")
        return release

    def prepare(self, target):
        revision(target)
        if not self.repository.exists():
            self.git("init", "--bare")
        trusted(self.repository, directory=True)
        self.git("fetch", "--no-tags", REPOSITORY, "+refs/heads/main:refs/heads/main")
        if self.git("rev-parse", "refs/heads/main").decode().strip() != target:
            raise ValueError("not_current_main")
        if self.previous:
            self.git("merge-base", "--is-ancestor", revision(self.previous), target)
        contents = {}
        for name in FILES:
            source = f"scripts/deploy/{name}"
            entry = self.git("ls-tree", target, "--", source).decode().split()
            if (
                len(entry) != 4
                or entry[0] not in ("100644", "100755")
                or entry[1] != "blob"
            ):
                raise ValueError("unsafe_source_entry")
            if int(self.git("cat-file", "-s", entry[2])) > 2_000_000:
                raise ValueError("oversized_companion_source")
            contents[name] = self.git("cat-file", "blob", entry[2])
            if name.endswith(".py"):
                compile(
                    contents[name], name, "exec"
                )  # Never execute fetched code in the installer.
        release = ROOT / "releases" / target
        if release.exists():
            self.check_release(target)
            if any(
                (release / name).read_bytes() != data for name, data in contents.items()
            ):
                raise ValueError("companion_source_mismatch")
            return
        with tempfile.TemporaryDirectory(
            prefix=".stage-", dir=ROOT / "releases"
        ) as staging:
            stage = Path(staging)
            for name, data in contents.items():
                atomic(stage / name, data, 0o444)
            atomic(
                stage / "manifest.json",
                json.dumps(
                    {
                        "revision": target,
                        "sha256": {
                            name: hashlib.sha256(data).hexdigest()
                            for name, data in contents.items()
                        },
                    }
                ).encode(),
                0o444,
            )
            # Units are parsed, not started. The source templates use the stable
            # helper path; installation pins ExecStart to the immutable release.
            self.command("systemd-analyze", "verify", str(stage / self.unit))
            stage.chmod(0o755)
            os.rename(stage, release)
            issues.sync_directory(release.parent)

    def properties(self):
        return dict(
            line.split("=", 1)
            for line in self.command(
                "systemctl",
                "show",
                self.unit,
                "-p",
                "LoadState",
                "-p",
                "ActiveState",
                "-p",
                "SubState",
                "-p",
                "MainPID",
                "-p",
                "ControlPID",
                "-p",
                "Job",
                "-p",
                "InvocationID",
                "-p",
                "FragmentPath",
                "-p",
                "DropInPaths",
                "-p",
                "NeedDaemonReload",
            )
            .decode()
            .splitlines()
        )

    def active(self):
        props = self.properties()
        if (
            props["Job"]
            or props["ControlPID"] != "0"
            or props["ActiveState"] not in ("active", "inactive", "failed")
        ):
            raise ValueError("unsettled_companion")
        return props["ActiveState"] == "active"

    def stopped(self):
        props = self.properties()
        if (
            props["ActiveState"] not in ("inactive", "failed")
            or props["MainPID"] != "0"
            or props["ControlPID"] != "0"
            or props["Job"]
        ):
            raise ValueError("companion_stop_unknown")
        group = Path("/sys/fs/cgroup/system.slice") / self.unit
        if not Path("/sys/fs/cgroup/cgroup.controllers").is_file():
            raise ValueError("cgroup_v2_required")
        if group.exists():
            events = dict(
                line.split()
                for line in (group / "cgroup.events").read_text().splitlines()
            )
            if events.get("populated") != "0":
                raise ValueError("companion_stop_unknown")

    def stop(self):
        if self.active():
            self.command("systemctl", "stop", self.unit)
        self.stopped()

    def install(self, target):
        release = self.check_release(target)
        atomic(UNITS / self.unit, unit_bytes(release, self.role), 0o644)
        link = ROOT / ".current-next"
        if os.path.lexists(link):
            raise ValueError("unsettled_companion_link")
        link.symlink_to(release)
        os.replace(link, ROOT / "current")
        issues.sync_directory(ROOT)
        self.command("systemctl", "daemon-reload")

    def start(self):
        self.command("systemctl", "start", self.unit)

    def verify(self, target, running):
        release = self.check_release(target)
        if (
            not (ROOT / "current").is_symlink()
            or (ROOT / "current").resolve() != release
            or trusted(UNITS / self.unit).read_bytes() != unit_bytes(release, self.role)
        ):
            raise ValueError("companion_installation_drift")
        identity = None
        for attempt in range(6 if running else 1):
            if attempt:
                time.sleep(1)
            props = self.properties()
            if (
                props["LoadState"] != "loaded"
                or props["FragmentPath"] != str(UNITS / self.unit)
                or props["DropInPaths"]
                or props["NeedDaemonReload"] != "no"
            ):
                raise ValueError("companion_unit_drift")
            if not running:
                self.stopped()
                return
            if (
                props["ActiveState"] != "active"
                or props["SubState"] != "running"
                or props["ControlPID"] != "0"
                or props["Job"]
                or not props["MainPID"].isdigit()
                or int(props["MainPID"]) <= 0
                or not props["InvocationID"]
            ):
                raise ValueError("companion_not_running")
            expected = ["/usr/bin/python3", "-I", str(release / ENTRY[self.role])]
            if self.role == "worker":
                expected.append("worker")
            actual = Path(f"/proc/{props['MainPID']}/cmdline").read_bytes()
            current = (props["MainPID"], props["InvocationID"])
            if actual != ("\0".join(expected) + "\0").encode() or (
                identity is not None and identity != current
            ):
                raise ValueError("companion_process_mismatch")
            identity = current


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--role", required=True, choices=SERVICES)
    parser.add_argument("--revision", required=True, type=revision)
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--start", action="store_true")
    action.add_argument("--reconcile", action="store_true")
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise ValueError("root_required")
    os.umask(0o077)
    directory(ROOT)
    directory(ROOT / "releases")
    directory(STATE, 0o700)
    trusted(UNITS, directory=True)
    with ExitStack() as locks:
        locks.enter_context(issues.worker_lock(STATE, name=".update.lock"))
        outer = (
            "june-debug-install.lock"
            if args.role == "worker"
            else "june-operator-deploy.lock"
        )
        # Existing host locks must already exist: never create a replacement inode.
        locks.enter_context(existing_lock(Path("/run/lock") / outer))
        if args.role == "sources":
            locks.enter_context(existing_lock(Path("/var/lib/june-deploy/deploy.lock")))
            with sqlite3.connect(
                "file:/var/lib/june-deploy/records/deploy.sqlite?mode=ro", uri=True
            ) as db:
                if any(
                    row[0]
                    for row in db.execute(
                        "SELECT value FROM state WHERE key IN ('operatorHold','recovery')"
                    )
                ):
                    raise ValueError("deployment_ownership_required")
        else:
            config = issues.validate_config(
                issues.parse_json(issues.read_private(issues.CONFIG))
            )
            locks.enter_context(
                issues.maintenance_lock(Path(config["stateDirectory"]), exclusive=True)
            )
            assert_idle(config)
        state_file = STATE / f"{args.role}.json"
        state = (
            issues.parse_json(issues.read_private(state_file))
            if state_file.exists()
            else None
        )
        host = Host(args.role, state.get("revision") if state else None)
        if state is None and (
            host.properties().get("FragmentPath")
            or os.path.lexists(ROOT / "current")
            or os.path.lexists(UNITS / host.unit)
        ):
            raise ValueError("unmanaged_companion")
        update(
            host,
            state,
            args.revision,
            lambda value: atomic(state_file, json.dumps(value).encode()),
            start=args.start,
            reconcile=args.reconcile,
        )
        print(
            json.dumps(
                {
                    "role": args.role,
                    "revision": args.revision,
                    "phase": "ready",
                    "running": host.active(),
                }
            )
        )


if __name__ == "__main__":
    try:
        main()
    except Exception:  # noqa: BLE001 - never disclose provider, config or subprocess errors
        raise SystemExit(
            "june_companion_update_blocked: inspect ownership, protected update state and service identity"
        ) from None
