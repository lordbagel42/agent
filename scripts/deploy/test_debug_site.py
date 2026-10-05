"""Controller decisions against controlled host effects, never live services."""

import copy
import tempfile
import threading
import unittest
import urllib.error
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from unittest.mock import Mock, patch

from debug_site import Host as InstalledHost
from debug_site import Interrupted, bundle_digest, run_once


OLD = "1" * 40
NEW = "2" * 40


class Host:
    def __init__(self):
        self.enabled = True
        self.target = NEW
        self.active = OLD
        self.forward = True
        self.same_inputs = False
        self.allowed = True
        self.fail_build = False
        self.fail_health = False
        self.calls = []
        self.binding_value = "original"

    def current(self):
        return self.active

    def fetch(self):
        self.calls.append("fetch")
        return self.target

    def ancestor(self, previous, target):
        return self.forward

    def unchanged(self, previous, target):
        return self.same_inputs

    def storage_allowed(self, revision):
        return self.allowed

    def binding(self):
        return self.binding_value

    def prepare(self, revision):
        self.calls.append(("prepare", revision))
        if self.fail_build:
            raise RuntimeError("build failed")

    def activate(self, revision):
        self.calls.append(("activate", revision))
        self.active = revision
        if revision == NEW and self.fail_health:
            raise RuntimeError("readiness failed")


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.host = Host()
        self.state = {
            "phase": "ready",
            "activeRevision": OLD,
            "targetRevision": OLD,
            "lastSeenRevision": OLD,
            "failedRevision": None,
            "reason": None,
        }
        self.saved = []

    def poll(self):
        def save(state):
            self.saved.append(copy.deepcopy(state))
            self.host.calls.append(("save", state["phase"]))

        run_once(self.host, self.state, save)

    def test_forward_update_records_intent_before_effects_and_confirms_identity(self):
        self.poll()
        self.assertEqual(
            self.host.calls,
            [
                "fetch",
                ("save", "building"),
                ("prepare", NEW),
                ("save", "activating"),
                ("activate", NEW),
                ("save", "ready"),
            ],
        )
        self.assertEqual(
            [value["phase"] for value in self.saved],
            ["building", "activating", "ready"],
        )
        self.assertEqual(self.saved[1]["activeRevision"], OLD)
        self.assertEqual(self.state["activeRevision"], NEW)
        self.assertIsNone(self.state["reason"])

    def test_failed_candidate_rolls_back_once_and_is_not_retried_by_later_polls(self):
        self.host.fail_health = True
        self.poll()
        self.assertEqual(self.host.calls[-3:-1], [("activate", NEW), ("activate", OLD)])
        self.assertEqual(self.state["phase"], "failed")
        self.assertEqual(self.state["activeRevision"], OLD)
        self.assertEqual(self.state["failedRevision"], NEW)
        self.host.enabled = False
        self.poll()
        self.assertEqual(self.state["phase"], "disabled")
        self.host.enabled = True
        self.host.calls.clear()
        self.poll()
        self.assertEqual(self.host.calls, ["fetch", ("save", "failed")])
        self.assertEqual(self.state["reason"], "health_failed")

    def test_interruption_is_a_durable_fence_not_permission_to_retry(self):
        for phase in ("building", "activating", "blocked"):
            with self.subTest(phase=phase):
                self.state["phase"] = phase
                self.host.calls.clear()
                self.poll()
                self.assertEqual(self.state["phase"], "blocked")
                self.assertEqual(self.host.calls, [("save", "blocked")])

        self.setUp()
        self.host.activate = Mock(side_effect=Interrupted)
        self.poll()
        self.assertEqual(self.state["phase"], "blocked")
        self.host.activate.assert_called_once_with(NEW)

    def test_unsettled_systemd_effects_are_not_treated_as_failed_candidates(self):
        host = InstalledHost.__new__(InstalledHost)
        for reply in (
            b"ActiveState=active\nMainPID=42\nControlPID=0\nJob=\n",
            b"ActiveState=failed\nMainPID=0\nControlPID=0\nJob=123\n",
            b"ActiveState=deactivating\nMainPID=0\nControlPID=19\nJob=\n",
        ):
            host.command = Mock(return_value=reply)
            with self.assertRaises(Interrupted):
                host.assert_settled("synthetic-build.service")
        with (
            tempfile.TemporaryDirectory() as directory,
            patch("debug_site.CGROUP", Path(directory)),
        ):
            root = Path(directory)
            (root / "cgroup.controllers").touch()
            group = root / "system.slice/synthetic-build.service"
            group.mkdir(parents=True)
            host.command = Mock(
                return_value=b"ActiveState=inactive\nMainPID=0\nControlPID=0\nJob=\n"
            )
            events = group / "cgroup.events"
            events.write_text("populated 1\nfrozen 0\n")
            with self.assertRaises(Interrupted):
                host.assert_settled("synthetic-build.service")
            events.write_text("populated 0\nfrozen 0\n")
            host.assert_settled("synthetic-build.service")
            events.unlink()
            group.rmdir()
            host.assert_settled("synthetic-build.service")

    def test_readiness_requires_one_stable_process_not_repeated_healthy_restarts(self):
        host = InstalledHost.__new__(InstalledHost)
        host.current = Mock(return_value=NEW)
        host.identity = Mock(side_effect=[b"first", b"first", b"restarted"])
        with patch("debug_site.time.sleep"):
            with self.assertRaises(ValueError):
                host.wait_ready(NEW)
            host.identity = Mock(return_value=b"stable")
            host.current.reset_mock()
            host.wait_ready(NEW)
            self.assertEqual(host.current.call_count, 6)

        # Restart inside the final real current() call, after its outer identity
        # sample but before current() samples its own identity around health.
        with tempfile.TemporaryDirectory() as directory, patch("debug_site.time.sleep"):
            root = Path(directory)
            release = root / "releases" / NEW
            release.mkdir(parents=True)
            (root / "current").symlink_to(release)
            probes = 0
            invocation = "first"

            def verify(commit):
                nonlocal probes, invocation
                probes += 1
                if probes == 6:
                    invocation = "restarted"
                return release

            real = InstalledHost.__new__(InstalledHost)
            real.verify = verify
            real.identity = lambda: invocation
            real.health = lambda: {"ready": True, "revision": NEW}
            with patch("debug_site.ROOT", root), self.assertRaises(ValueError):
                real.wait_ready(NEW)

    def test_health_never_follows_redirects(self):
        paths = []

        class Redirect(BaseHTTPRequestHandler):
            def do_GET(self):
                paths.append(self.path)
                self.send_response(302)
                self.send_header("Location", "/elsewhere")
                self.end_headers()

            def log_message(self, *args):
                pass

        server = HTTPServer(("127.0.0.1", 0), Redirect)
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        try:
            with patch(
                "debug_site.HEALTH_URL", f"http://127.0.0.1:{server.server_port}/health"
            ):
                with self.assertRaises(urllib.error.HTTPError):
                    InstalledHost.__new__(InstalledHost).health()
                self.assertEqual(paths, ["/health"])
        finally:
            server.shutdown()
            thread.join()
            server.server_close()

    def test_policy_history_and_live_drift_prevent_builds(self):
        for change, reason in (
            ("forward", "non_fast_forward"),
            ("allowed", "storage_policy_changed"),
            ("active", "current_unhealthy"),
        ):
            with self.subTest(change=change):
                self.setUp()
                setattr(self.host, change, False if change != "active" else NEW)
                self.poll()
                self.assertEqual(self.state["phase"], "blocked")
                self.assertEqual(self.state["reason"], reason)
                self.assertNotIn(("prepare", NEW), self.host.calls)

    def test_unchanged_inputs_do_not_restart_or_relabel_the_running_process(self):
        self.host.same_inputs = True
        self.poll()
        self.assertEqual(self.host.calls, ["fetch", ("save", "ready")])
        self.assertEqual(self.state["activeRevision"], OLD)
        self.assertEqual(self.state["lastSeenRevision"], NEW)
        self.assertEqual(self.state["targetRevision"], NEW)
        self.assertEqual(self.state["reason"], "source_unchanged")

    def test_build_failure_leaves_the_live_service_untouched(self):
        self.host.fail_build = True
        self.poll()
        self.assertEqual(
            self.host.calls,
            ["fetch", ("save", "building"), ("prepare", NEW), ("save", "failed")],
        )
        self.assertEqual(self.state["phase"], "failed")
        self.assertEqual(self.state["reason"], "preflight_failed")

    def test_bundle_digest_rejects_linked_output_and_detects_changed_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "server.mjs").write_text("first")
            first = bundle_digest(root)
            (root / "server.mjs").write_text("second")
            self.assertNotEqual(bundle_digest(root), first)
            (root / "escape").symlink_to("/etc/passwd")
            with self.assertRaises(ValueError):
                bundle_digest(root)
            (root / "escape").unlink()
            (root / "alias").hardlink_to(root / "server.mjs")
            with self.assertRaises(ValueError):
                bundle_digest(root)


if __name__ == "__main__":
    unittest.main()
