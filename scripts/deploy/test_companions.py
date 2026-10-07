"""Companion updates never touch live services; fixtures use disposable releases."""

import copy
import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

OLD = "1" * 40
NEW = "2" * 40


class Host:
    def __init__(self):
        self.calls = []
        self.running = True
        self.fail = None
        self.current = OLD

    def prepare(self, target):
        self.calls.append(("prepare", target))

    def verify(self, target, running):
        self.calls.append(("verify", target, running))
        if self.fail == "verify" or self.current != target or self.running != running:
            raise ValueError("not_ready")

    def active(self):
        return self.running

    def stop(self):
        self.calls.append("stop")
        if self.fail == "stop":
            raise ValueError("unsettled")
        self.running = False

    def install(self, target):
        self.calls.append(("install", target))
        self.current = target

    def start(self):
        self.calls.append("start")
        self.running = True


class Companions(unittest.TestCase):
    def setUp(self):
        path = Path(__file__).with_name("companions.py")
        self.assertTrue(path.exists(), "companion update tooling is not implemented")
        spec = importlib.util.spec_from_file_location("companions", path)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.host = Host()
        self.state = {"phase": "ready", "revision": OLD, "running": True}
        self.saved = []

    def save(self, value):
        self.saved.append(copy.deepcopy(value))
        self.host.calls.append(("save", value["phase"]))

    def test_intent_precedes_stop_and_loaded_identity_precedes_success(self):
        self.module.update(self.host, self.state, NEW, self.save)
        self.assertEqual(
            self.host.calls,
            [
                ("verify", OLD, True),
                ("prepare", NEW),
                ("save", "applying"),
                "stop",
                ("install", NEW),
                ("verify", NEW, False),
                "start",
                ("verify", NEW, True),
                ("save", "ready"),
            ],
        )
        self.assertEqual(
            self.saved[0], {"phase": "applying", "revision": NEW, "running": True}
        )
        self.assertEqual(
            self.state, {"phase": "ready", "revision": NEW, "running": True}
        )

    def test_failed_stop_and_unhealthy_start_fence_retries_without_rollback(self):
        for failure in ("stop", "verify"):
            with self.subTest(failure=failure):
                self.setUp()
                # Allow the old installation's identity check; fail the new one.
                original = self.host.verify
                if failure == "verify":

                    def verify(target, running, original=original):
                        if target == NEW and running:
                            raise ValueError("not_ready")
                        original(target, running)

                    self.host.verify = verify
                else:
                    self.host.fail = failure
                with self.assertRaises(ValueError):
                    self.module.update(self.host, self.state, NEW, self.save)
                self.assertEqual(self.state["phase"], "applying")
                self.host.calls.clear()
                with self.assertRaisesRegex(ValueError, "reconciliation_required"):
                    self.module.update(self.host, self.state, NEW, self.save)
                self.assertEqual(self.host.calls, [])

    def test_reconcile_only_observes_and_never_replays_service_effects(self):
        self.state.update(phase="applying", revision=NEW)
        self.host.current = NEW
        self.module.update(self.host, self.state, NEW, self.save, reconcile=True)
        self.assertEqual(self.host.calls, [("verify", NEW, True), ("save", "ready")])
        self.assertEqual(self.state["phase"], "ready")

    def test_reload_revealing_an_override_cannot_start_the_unit(self):
        original = self.host.verify

        def verify(target, running):
            if target == NEW and not running:
                raise ValueError("companion_unit_drift")
            original(target, running)

        self.host.verify = verify
        with self.assertRaisesRegex(ValueError, "companion_unit_drift"):
            self.module.update(self.host, self.state, NEW, self.save)
        self.assertNotIn("start", self.host.calls)
        self.assertEqual(self.state["phase"], "applying")

    def test_service_failure_during_staging_does_not_rewrite_running_intent(self):
        def prepare(_target):
            self.host.running = False

        self.host.prepare = prepare
        self.module.update(self.host, self.state, NEW, self.save)
        self.assertTrue(self.state["running"])
        self.assertIn("start", self.host.calls)

    def test_install_stays_disabled_without_explicit_start_and_ready_is_idempotent(
        self,
    ):
        self.host.running = False
        self.module.update(self.host, None, NEW, self.save)
        self.assertNotIn("start", self.host.calls)
        self.assertEqual(
            self.saved[-1], {"phase": "ready", "revision": NEW, "running": False}
        )
        self.host.calls.clear()
        self.module.update(self.host, self.saved[-1], NEW, self.save)
        self.assertEqual(self.host.calls, [("verify", NEW, False)])

    def test_worker_maintenance_gate_excludes_live_dispatch_without_replacing_lock(
        self,
    ):
        spec = importlib.util.spec_from_file_location(
            "issues", Path(__file__).with_name("issues.py")
        )
        issues = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(issues)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = {"stateDirectory": directory}
            with issues.maintenance_lock(root, exclusive=False):
                inode = (root / ".maintenance.lock").stat().st_ino
                with (
                    self.assertRaises(issues.IssueError),
                    issues.maintenance_lock(root, exclusive=True),
                ):
                    self.fail("updater interrupted an active dispatch")
            with (
                issues.maintenance_lock(root, exclusive=True),
                self.assertRaises(issues.IssueError),
                issues.maintenance_lock(root, exclusive=False),
            ):
                self.fail("worker admitted a job during update")
            self.assertEqual((root / ".maintenance.lock").stat().st_ino, inode)
            (root / "active.json").write_text(json.dumps({"phase": "unknown"}))
            with self.assertRaisesRegex(ValueError, "issue_claim_unsettled"):
                self.module.assert_idle(config)

    def test_unit_is_pinned_to_release_and_drift_is_not_adopted(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch.object(self.module, "ROOT", root):
                release = root / "releases" / NEW
                release.mkdir(parents=True)
                template = Path(__file__).with_name("june-issues.service").read_bytes()
                (release / "june-issues.service").write_bytes(template)
                rendered = self.module.unit_bytes(release, "worker")
                self.assertIn(f"/releases/{NEW}/issues.py worker".encode(), rendered)
                self.assertNotIn(b"/current/", rendered)
                (release / "june-issues.service").write_bytes(b"ExecStart=/bin/false\n")
                with self.assertRaisesRegex(ValueError, "invalid_unit_template"):
                    self.module.unit_bytes(release, "worker")

    def test_real_git_release_installation_and_integrity(self):
        # Catch extraction from checkout/HEAD instead of the reviewed commit,
        # swapped unit paths, in-place installs and accepting changed bytes.
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as temporary:
            root = Path(temporary).resolve()
            checkout = root / "source"
            checkout.mkdir()

            def git(*args):
                return (
                    subprocess.run(
                        ["git", "-C", str(checkout), *args],
                        check=True,
                        capture_output=True,
                    )
                    .stdout.decode()
                    .strip()
                )

            git("init", "--initial-branch=main")
            sources = checkout / "scripts/deploy"
            sources.mkdir(parents=True)
            for name in (
                *self.module.FILES,
                "issue_credentials.py",
                "june-issue-credentials.service",
            ):
                (sources / name).write_bytes(
                    Path(__file__).with_name(name).read_bytes()
                )
            git("add", ".")
            git(
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.test",
                "commit",
                "-m",
                "fixture",
            )
            commit = git("rev-parse", "HEAD")
            (sources / "issues.py").write_text(
                "raise RuntimeError('unpublished checkout code')\n"
            )
            installation = root / "install"
            (installation / "releases").mkdir(parents=True)
            state = root / "state"
            state.mkdir(mode=0o700)
            units = root / "units"
            units.mkdir()
            with (
                patch.object(self.module, "ROOT", installation),
                patch.object(self.module, "STATE", state),
                patch.object(self.module, "UNITS", units),
                patch.object(self.module, "REPOSITORY", str(checkout)),
            ):
                host = self.module.Host("worker")
                command = host.command

                def controlled(*args):
                    if args == ("systemctl", "daemon-reload"):
                        return b""
                    return command(*args)

                host.command = controlled
                host.prepare(commit)
                release = installation / "releases" / commit
                self.assertNotIn(
                    b"unpublished checkout code", (release / "issues.py").read_bytes()
                )
                host.install(commit)
                self.assertEqual((installation / "current").resolve(), release)
                self.assertIn(
                    str(release / "issues.py").encode(),
                    (units / "june-issues.service").read_bytes(),
                )
                host.check_release(commit)
                # June hosts the exporter AND renewer: installing either must
                # not move the other's stable link or invalidate its manifest.
                renewal = self.module.Host("credentials")
                (installation / "credentials/releases").mkdir(parents=True)
                renewal.command = controlled
                renewal.prepare(commit)
                renewal.install(commit)
                credential_release = installation / "credentials/releases" / commit
                self.assertEqual(
                    (installation / "credentials/current").resolve(), credential_release
                )
                self.assertEqual((installation / "current").resolve(), release)
                self.assertIn(
                    str(credential_release / "issue_credentials.py").encode(),
                    (units / "june-issue-credentials.service").read_bytes(),
                )
                renewal.check_release(commit)
                host.check_release(commit)
                (release / "issues.py").chmod(0o644)
                (release / "issues.py").write_text("# corrupted\n")
                with self.assertRaisesRegex(ValueError, "companion_release_drift"):
                    host.check_release(commit)


if __name__ == "__main__":
    unittest.main()
