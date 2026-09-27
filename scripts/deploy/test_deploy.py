"""Core safety checks. All Git, HTTP service and durable data are disposable."""

import importlib.util
import io
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "deploy", Path(__file__).with_name("deploy.py")
)
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)

SERVICE = """
import json, os
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
release = json.loads(Path(".june-release.json").read_text())
data = Path(os.environ["DATA"])
with (data / "starts").open("a") as f: f.write(release["revision"] + "\\n")
if Path("src/console/view.ts").read_text().startswith("bad"):
    with (data / "messages").open("a") as f: f.write("candidate new message\\n")
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        body = {"name": "June", "revision": release["revision"], "ready": not Path("src/console/view.ts").read_text().startswith("bad")}
        self.send_response(200 if body["ready"] else 503); self.end_headers()
        self.wfile.write(json.dumps(body).encode())
    def do_POST(self):
        with (data / "drains").open("a") as f: f.write(release["revision"] + "\\n")
        self.send_response(200); self.end_headers()
        self.wfile.write(json.dumps({"revision": release["revision"], "drained": not (data / "busy").exists()}).encode())
    def do_DELETE(self):
        self.send_response(200); self.end_headers()
        self.wfile.write(json.dumps({"revision": release["revision"], "drained": False}).encode())
HTTPServer.allow_reuse_address = True
HTTPServer(("127.0.0.1", int(os.environ["PORT"])), Handler).serve_forever()
"""


class FixtureHost(deploy.Host):
    def __init__(self, root):
        import socket

        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        self.port = port
        self.root = root
        self.stage_root = root
        self.repo = root / "repo"
        self.releases = root / "releases"
        self.releases.mkdir()
        self.current = root / "current"
        self.process = None
        self.env = {
            "PATH": os.environ["PATH"],
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": "/dev/null",
        }
        self.config = {
            "origin": f"http://127.0.0.1:{port}",
            "healthSeconds": 0.6,
            "transitions": [],
        }
        self.token = "fixture-only-secret"
        self.after_prepare = None
        self.repo.mkdir()
        subprocess.run(["git", "init", "-q", "-b", "main", str(self.repo)], check=True)
        (self.repo / "src").mkdir()
        (self.repo / "src/service.py").write_text(SERVICE)
        (self.repo / "src/main.ts").write_text("export {};\n")
        (self.repo / "package.json").write_text('{"packageManager":"pnpm@10.33.0"}')
        for name in (
            "pnpm-lock.yaml",
            "pnpm-workspace.yaml",
            "tsconfig.json",
            "biome.json",
        ):
            (self.repo / name).write_text("{}\n")
        self.data = root / "data"
        self.data.mkdir()
        (self.data / "messages").write_text("new messages must survive\n")

    def commit(self, file, text):
        (self.repo / file).parent.mkdir(parents=True, exist_ok=True)
        (self.repo / file).write_text(text)
        self.git("add", ".")
        self.git(
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "-qm",
            "fixture-secret-must-not-enter-feed",
        )
        return self.git("rev-parse", "HEAD")

    def fetch(self):
        return self.git("rev-parse", "main")

    def build(self, stage):
        if (stage / "src/broken").exists():
            raise RuntimeError("SECRET_FROM_BUILD")
        self.run_build(
            stage,
            [
                sys.executable,
                "-c",
                "import ast,pathlib,sys; ast.parse(pathlib.Path(sys.argv[1]).read_text())",
                str(stage / "src/service.py"),
            ],
        )

    def build_unit_stopped(self, stage):
        return True  # Fixtures run gated local children, not production systemd.

    def binding(self):
        return "a" * 64

    def prepare(self, revision):
        result = super().prepare(revision)
        if self.after_prepare:
            self.after_prepare()
            self.after_prepare = None
        return result

    def service(self, action):
        if action == "stop":
            if self.process:
                self.process.terminate()
                self.process.wait(timeout=3)
                self.process = None
        else:
            self.process = subprocess.Popen(
                [sys.executable, "src/service.py"],
                cwd=self.current.resolve(),
                env={**self.env, "DATA": str(self.data), "PORT": str(self.port)},
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )

    def running(self, revision):
        return bool(
            self.process
            and self.process.poll() is None
            and Path(f"/proc/{self.process.pid}/cwd").resolve()
            == self.releases / revision
        )

    def settled(self):
        return True


class GitHubFixture:
    def __init__(self):
        self.runs = {}
        self.statuses = []
        self.writes = []
        self.lose_create_response = False

    def open(self, request, timeout):
        assert timeout == 5
        assert request.get_header("Authorization") == "Bearer fixture-token"
        assert request.get_header("Accept") == "application/vnd.github+json"
        prefix = "https://api.github.com/repos/lordbagel42/agent/"
        assert request.full_url.startswith(prefix)
        path = request.full_url.removeprefix(prefix)
        method = request.get_method()
        body = json.loads(request.data) if request.data else None
        if method == "GET":
            sha = path.split("/")[1]
            result = {
                "check_runs": [
                    run for run in self.runs.values() if run["head_sha"] == sha
                ]
            }
        elif path == "check-runs":
            run_id = len(self.runs) + 41
            result = {
                **body,
                "id": run_id,
                "html_url": f"https://github.com/lordbagel42/agent/runs/{run_id}",
            }
            self.runs[run_id] = result
            self.writes.append((method, body))
            if self.lose_create_response:
                self.lose_create_response = False
                raise deploy.urllib.error.URLError("SECRET lost response")
        elif path.startswith("check-runs/"):
            result = self.runs[int(path.split("/")[1])]
            result.update(body)
            self.writes.append((method, body))
        else:
            assert path.startswith("statuses/") and method == "POST"
            self.statuses.append(body)
            result = body
        response = io.BytesIO(json.dumps(result).encode())
        response.status = 201 if method == "POST" else 200
        return response


class ControllerProvenance(unittest.TestCase):
    def test_only_matching_protected_installation_attests_controller_revision(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            installed = root / "installed"
            installed.mkdir(mode=0o700)
            script = installed / "deploy.py"
            script.write_text("# installed controller\n")
            script.chmod(0o600)
            preflight = installed / "preflight.sh"
            preflight.write_text("# installed preflight\n")
            preflight.chmod(0o600)
            provenance = {"revision": "c" * 40, "digest": deploy.tree_digest(installed)}
            with patch.object(deploy, "__file__", str(script)):
                for missing in (None, {}, "a" * 40, {"revision": "a" * 40}):
                    self.assertIsNone(deploy.installed_controller_revision(missing))
                self.assertEqual(
                    deploy.installed_controller_revision(provenance), "c" * 40
                )
                for field, value in (("revision", "not-a-sha"), ("digest", "d" * 64)):
                    self.assertIsNone(
                        deploy.installed_controller_revision(
                            {**provenance, field: value}
                        )
                    )
                preflight.write_text("# replaced preflight\n")
                self.assertIsNone(deploy.installed_controller_revision(provenance))
                preflight.write_text("# installed preflight\n")
                installed.chmod(0o777)
                self.assertIsNone(deploy.installed_controller_revision(provenance))
                installed.chmod(0o700)
                link = root / "linked"
                link.symlink_to(installed)
                with patch.object(deploy, "__file__", str(link / "deploy.py")):
                    self.assertIsNone(deploy.installed_controller_revision(provenance))
                controller = deploy.installed_controller_revision(provenance)
            store = deploy.Store(root / "records", root / "feed.json", "a" * 40)
            try:
                self.assertNotIn(
                    "controllerRevision", json.loads(store.feed.read_text())
                )
            finally:
                store.close()
            store = deploy.Store(
                root / "records",
                root / "feed.json",
                "a" * 40,
                controller_revision=controller,
            )
            try:
                store.event("b" * 40, "healthy")
                feed = json.loads(store.feed.read_text())
                self.assertEqual(feed["lastHealthyRevision"], "b" * 40)
                self.assertEqual(feed["controllerRevision"], "c" * 40)
            finally:
                store.close()


class DeploymentSafety(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.host = FixtureHost(root)
        # tearDown is skipped if startup health fails in setUp.
        self.addCleanup(self.host.service, "stop")
        self.first = self.host.commit("src/console/view.ts", "one")
        self.host.prepare(self.first)
        self.host.switch(self.first)
        self.host.service("start")
        self.assertTrue(self.host.healthy(self.first))
        self.store = deploy.Store(root / "records", root / "feed.json", self.first)
        self.loop = deploy.Deployer(self.host, self.store)

    def tearDown(self):
        self.host.service("stop")
        self.store.close()
        self.tmp.cleanup()

    def test_crashed_preparation_reclaims_only_recorded_unsealed_stages(self):
        target = self.host.commit("src/console/view.ts", "two")
        unknown = self.host.stage_root / "stage-unknown1"
        unknown.mkdir()
        (unknown / "keep").write_text("unknown data")
        release = self.host.releases / self.first
        marker = (release / ".june-release.json").read_bytes()
        build = self.host.build
        rename = os.rename
        write_record = deploy.atomic_json
        for phase in ("extracted", "gate", "built", "sealed"):
            with self.subTest(phase=phase):
                pid = os.fork()
                if pid == 0:

                    def crash_record(path, value, *args, phase=phase):
                        if phase == "gate" and value.get("launcherPid"):
                            os._exit(91)  # Spawned but not durably authorized.
                        write_record(path, value, *args)

                    def crash_build(stage, phase=phase):
                        if phase == "extracted":
                            os._exit(91)
                        build(stage)
                        if phase == "built":
                            os._exit(91)

                    def crash_promotion(source, destination):
                        if destination == self.host.releases / target:
                            os._exit(91)
                        rename(source, destination)

                    try:
                        with (
                            deploy.deployment_lock(self.host.root / "lock"),
                            patch.object(self.host, "build", crash_build),
                            patch.object(deploy.os, "rename", crash_promotion),
                            patch.object(deploy, "atomic_json", crash_record),
                        ):
                            self.host.prepare(target)
                    finally:
                        os._exit(92)
                _, status = os.waitpid(pid, 0)
                self.assertEqual(os.waitstatus_to_exitcode(status), 91)
                records = list(self.host.stage_root.glob(".stage-*.json"))
                self.assertEqual(len(records), 1)
                stage = self.host.stage_root / records[0].name[1:-5]
                self.assertTrue((stage / "src/service.py").is_file())
                self.assertFalse(self.store.get("intent"))
                # Startup recovery runs even with no new main and no activation.
                with deploy.deployment_lock(self.host.root / "lock"):
                    self.host.recover_stages()
                    self.host.recover_stages()
                self.assertEqual(stage.exists(), phase == "sealed")
                self.assertEqual(records[0].exists(), phase == "sealed")
        self.assertEqual((unknown / "keep").read_text(), "unknown data")
        self.assertEqual((release / ".june-release.json").read_bytes(), marker)
        self.assertTrue(self.host.running(self.first))
        self.assertEqual(
            (self.host.data / "messages").read_text(), "new messages must survive\n"
        )

    def test_restart_preserves_live_launcher_then_waits_for_unit_settlement(self):
        target = self.host.commit("src/console/view.ts", "two")
        pid = os.fork()
        if pid == 0:

            def busy_build(stage):
                self.host.run_build(
                    stage,
                    [
                        sys.executable,
                        "-c",
                        (
                            "import pathlib,sys,time; p=pathlib.Path(sys.argv[1]); "
                            "(p/'ready').touch(); end=time.monotonic()+10\n"
                            "while not (p/'done').exists() and time.monotonic()<end: time.sleep(.01)"
                        ),
                        str(stage),
                    ],
                )

            try:
                with (
                    deploy.deployment_lock(self.host.root / "lock"),
                    patch.object(self.host, "build", busy_build),
                ):
                    self.host.prepare(target)
            finally:
                os._exit(92)
        try:
            end = time.monotonic() + 5
            while time.monotonic() < end:
                ready = list(self.host.stage_root.glob("stage-*/ready"))
                if ready:
                    break
                time.sleep(0.01)
            self.assertEqual(len(ready), 1)
        finally:
            os.kill(pid, signal.SIGKILL)
            os.waitpid(pid, 0)
        stage = ready[0].parent
        with deploy.deployment_lock(self.host.root / "lock"):
            with patch.object(self.host, "build_unit_stopped") as unit:
                self.host.recover_stages()
                unit.assert_not_called()  # Live launcher vetoes even an absent unit.
            self.assertTrue((stage / "src/service.py").exists())
            (stage / "done").touch()
            launcher = self.host.read_stage_record(stage)["launcherPid"]
            end = time.monotonic() + 5
            while time.monotonic() < end:
                try:
                    os.kill(launcher, 0)
                except ProcessLookupError:
                    break
                time.sleep(0.01)
            else:
                self.fail("fixture launcher did not exit")

            # Even a vanished unit cannot settle a possibly queued submission.
            with patch.object(self.host, "build_unit_stopped", return_value=True):
                self.host.recover_stages()
            self.assertTrue(stage.exists())
            record = self.host.read_stage_record(stage)
            self.assertFalse(record["launchSettled"])
            # Simulate recovery after a host reboot: the old request cannot run,
            # but the independent manager checks must still veto active builds.
            record["bootId"] = "00000000-0000-0000-0000-000000000000"
            deploy.atomic_json(self.host.stage_record(stage), record)
            with patch.object(self.host, "build_unit_stopped", return_value=False):
                self.host.recover_stages()
            self.assertTrue(stage.exists())
            with patch.object(
                self.host, "build_unit_stopped", side_effect=OSError("unavailable")
            ):
                self.host.recover_stages()
            self.assertTrue(stage.exists())

            # A crash midway through rmtree keeps the external identity record.
            def partial_remove(path):
                (path / "ready").unlink()
                raise OSError("interrupted removal")

            with patch.object(deploy.shutil, "rmtree", side_effect=partial_remove):
                self.host.recover_stages()
            self.assertTrue(self.host.stage_record(stage).exists())
            self.host.recover_stages()
            self.assertFalse(stage.exists())
            self.assertFalse(self.host.stage_record(stage).exists())
        self.assertTrue(self.host.running(self.first))
        self.assertEqual(
            (self.host.data / "messages").read_text(), "new messages must survive\n"
        )

    def test_stage_identity_and_manager_evidence_fail_closed(self):
        stage = self.host.stage_root / "stage-fixture1"
        stage.mkdir()
        meta = stage.stat()
        record = {
            "version": 1,
            "device": meta.st_dev,
            "inode": meta.st_ino,
            "launcherPid": 0,
            "launchSettled": False,
            "bootId": Path("/proc/sys/kernel/random/boot_id").read_text().strip(),
        }
        with deploy.deployment_lock(self.host.root / "lock"):
            for change in ({"inode": meta.st_ino + 1}, {"version": 2}):
                deploy.atomic_json(self.host.stage_record(stage), {**record, **change})
                self.host.recover_stages()
                self.assertTrue(stage.exists())
            deploy.atomic_json(self.host.stage_record(stage), record)
            stage.rmdir()
            stage.symlink_to(self.host.data, target_is_directory=True)
            self.host.recover_stages()
            self.assertTrue(stage.is_symlink())
            self.assertEqual(
                (self.host.data / "messages").read_text(), "new messages must survive\n"
            )
        # Failure to persist the launcher identity must close its gate, not run
        # an untracked process. This exercises the actual spawned gate child.
        witness = self.host.root / "unexpected-build"
        with (
            patch.object(deploy, "atomic_json", side_effect=OSError("disk full")),
            self.assertRaises(OSError),
        ):
            self.host.run_build(
                stage,
                [
                    sys.executable,
                    "-c",
                    "import pathlib,sys; pathlib.Path(sys.argv[1]).touch()",
                    str(witness),
                ],
            )
        self.assertFalse(witness.exists())
        stopped = {
            "LoadState": "not-found",
            "ActiveState": "inactive",
            "SubState": "dead",
            "MainPID": "0",
            "ControlPID": "0",
            "Job": "",
            "ControlGroup": "",
        }
        for change in (
            {},
            {"LoadState": "loaded", "ActiveState": "failed", "SubState": "failed"},
            {"ActiveState": "active"},
            {"SubState": "start"},
            {"MainPID": "123"},
            {"ControlPID": "456"},
            {"Job": "12"},
            {"ControlGroup": "/system.slice/june-build-stage-fixture1.service"},
            {"LoadState": "error"},
            {"ControlGroup": None},
        ):
            with self.subTest(change=change):
                output = "\n".join(
                    f"{key}={value}"
                    for key, value in {**stopped, **change}.items()
                    if value is not None
                ).encode()
                with patch.object(
                    deploy.subprocess, "check_output", return_value=output
                ):
                    self.assertEqual(
                        deploy.Host.build_unit_stopped(self.host, stage),
                        not change or change.get("ActiveState") == "failed",
                    )

    def test_github_details_update_one_run_and_link_existing_commit_statuses(self):
        api = GitHubFixture()
        reporter = deploy.GitHubStatuses(self.store)
        self.loop = deploy.Deployer(self.host, self.store, reporter)
        with (
            patch.object(deploy, "private_file", return_value="fixture-token\n"),
            patch.object(reporter.opener, "open", side_effect=api.open),
        ):
            target = self.host.commit("src/console/view.ts", "two")
            self.store.set("github-status:" + target, '{"state":"pending"}')
            (self.host.data / "busy").touch()
            self.loop.tick()
            self.loop.tick()
            self.assertEqual(len(api.runs), 1)
            self.assertEqual(api.runs[41]["status"], "queued")
            self.assertIn("drain_busy", api.runs[41]["output"]["summary"])
            (self.host.data / "busy").unlink()
            self.loop.tick()
            writes = len(api.writes)
            self.loop.tick()
            self.assertEqual(len(api.writes), writes)
            self.assertEqual(api.runs[41]["conclusion"], "success")
            self.assertEqual(api.runs[41]["head_sha"], target)
            self.assertIn("activating", api.runs[41]["output"]["text"])
            self.assertEqual(
                api.statuses[-1]["target_url"],
                "https://github.com/lordbagel42/agent/runs/41",
            )
            self.assertEqual(api.statuses[-1]["state"], "success")
            failed = self.host.commit("src/console/view.ts", "bad health")
            self.loop.tick()
            self.assertEqual(api.runs[42]["conclusion"], "failure")
            self.assertIn("rolled_back", api.runs[42]["output"]["summary"])
            self.assertIn("health_failed", api.runs[42]["output"]["text"])
            self.assertTrue(self.host.running(target))
            self.assertEqual(
                len(api.statuses), 2, "new commits should have only the native check"
            )
            self.store.event(failed, "fetch_failed", "fetch_failed")
            self.loop.tick()
            self.assertEqual(api.runs[42]["conclusion"], "failure")
            skipped = self.host.commit("src/console/view.ts", "three")
            newest = self.host.commit("src/console/view.ts", "four")
            self.loop.tick()
            outcomes = {run["head_sha"]: run["conclusion"] for run in api.runs.values()}
            self.assertEqual(outcomes[skipped], "skipped")
            self.assertEqual(outcomes[newest], "success")

    def test_github_lost_response_recovers_existing_run_after_restart_without_redeploying(
        self,
    ):
        api = GitHubFixture()
        api.lose_create_response = True
        target = self.host.commit("src/console/view.ts", "two")
        reporter = deploy.GitHubStatuses(self.store)
        self.loop = deploy.Deployer(self.host, self.store, reporter)
        with (
            patch.object(deploy, "private_file", return_value="fixture-token"),
            patch.object(reporter.opener, "open", side_effect=api.open),
        ):
            self.loop.tick()
        self.assertEqual(self.store.status(target), "healthy")
        self.assertTrue(self.host.running(target))
        self.assertNotIn("SECRET", self.store.feed.read_text())
        self.assertFalse(self.store.get("blocked"))
        self.store.close()
        self.store = deploy.Store(
            self.host.root / "records", self.host.root / "feed.json", self.first
        )
        reporter = deploy.GitHubStatuses(self.store)
        self.loop = deploy.Deployer(self.host, self.store, reporter)
        with (
            patch.object(deploy, "private_file", return_value="fixture-token"),
            patch.object(reporter.opener, "open", side_effect=api.open),
        ):
            self.loop.tick()
            self.loop.tick()
        self.assertEqual(len(api.runs), 1)
        self.assertEqual([method for method, _ in api.writes], ["POST", "PATCH"])
        self.assertEqual(api.runs[41]["conclusion"], "success")
        self.assertEqual(
            (self.host.data / "starts").read_text().splitlines(), [self.first, target]
        )

    def test_github_report_uses_observation_time_and_only_allowlisted_reasons(self):
        with patch.object(deploy.time, "time_ns", return_value=2_000_000_000):
            self.store.event(self.first, "received", committed_at=0)
        with patch.object(deploy.time, "time_ns", return_value=7_250_000_000):
            self.store.event(self.first, "blocked", "unsafe_rollback")
        report = deploy.GitHubStatuses(self.store).report(self.first)
        self.assertEqual(report["started_at"], "1970-01-01T00:00:02Z")
        self.assertEqual(report["completed_at"], "1970-01-01T00:00:07.250000Z")
        self.assertEqual(report["conclusion"], "action_required")
        self.assertIn("5.25 s", report["output"]["summary"])
        self.assertIn("unsafe_rollback", report["output"]["summary"])
        self.store.event(self.first, "blocked", "SECRET arbitrary diagnostic")
        safe = json.dumps(deploy.GitHubStatuses(self.store).report(self.first))
        self.assertNotIn("SECRET", safe)
        self.assertNotIn("arbitrary", safe)

    def test_low_disk_defers_without_build_or_drain_and_recovers_without_a_new_commit(
        self,
    ):
        target = self.host.commit("src/console/view.ts", "two")
        disk = deploy.shutil.disk_usage(self.host.root)
        with patch.object(
            deploy.shutil,
            "disk_usage",
            return_value=disk._replace(free=4 * 1024**3 - 1),
        ):
            self.loop.tick()
            self.loop.tick()
        self.assertEqual(self.store.status(target), "deferred")
        self.assertEqual(self.store.get("active"), self.first)
        self.assertFalse(self.store.get("intent"))
        self.assertFalse((self.host.releases / target).exists())
        self.assertFalse((self.host.data / "drains").exists())
        self.assertEqual(
            (self.host.data / "starts").read_text().splitlines(), [self.first]
        )
        events = json.loads(self.store.feed.read_text())["events"]
        self.assertEqual(
            [event["status"] for event in events], ["received", "deferred"]
        )
        self.assertEqual(events[-1]["reason"], "insufficient_disk")

        available = 4 * 1024**3
        build = self.host.build

        def growing_build(stage):
            nonlocal available
            build(stage)
            available = 1024**3 - 1

        with (
            patch.object(
                deploy.shutil,
                "disk_usage",
                side_effect=lambda _: disk._replace(free=available),
            ),
            patch.object(self.host, "build", growing_build),
        ):
            self.loop.tick()
        self.assertEqual(self.store.status(target), "deferred")
        self.assertFalse((self.host.releases / target).exists())
        self.assertEqual(list(self.host.stage_root.glob("stage-*")), [])
        self.assertFalse((self.host.data / "drains").exists())
        with patch.object(
            deploy.shutil, "disk_usage", return_value=disk._replace(free=4 * 1024**3)
        ):
            self.loop.tick()
        self.assertEqual(self.store.get("active"), target)
        self.assertEqual(
            (self.host.data / "messages").read_text(), "new messages must survive\n"
        )

    def test_retention_protects_bootstrap_recent_running_and_unowned_paths(self):
        unknown = self.host.releases / ("f" * 40)
        unknown.mkdir()
        (unknown / "unowned").write_text("leave me alone")
        revisions = []
        for content in ("two", "three", "four", "five"):
            target = self.host.commit("src/console/view.ts", content)
            revisions.append(target)
            self.loop.tick()
            self.assertEqual(self.store.get("active"), target)
        obsolete = self.host.releases / revisions[0]
        self.assertFalse(obsolete.exists())
        for commit in (self.first, *revisions[1:]):
            self.assertTrue(
                (self.host.releases / commit / ".june-release.json").is_file()
            )
        self.assertEqual((unknown / "unowned").read_text(), "leave me alone")
        self.host.prune({revisions[-1]})
        self.assertTrue(self.host.running(revisions[-1]))

        # An interrupted unlink can resume, but a symlink must never reach data.
        trash = self.host.releases / f".prune-{revisions[0]}"
        trash.mkdir()
        (trash / "partial").write_text("incomplete cleanup")
        self.host.prune({revisions[0]})
        self.assertFalse(trash.exists())
        obsolete.symlink_to(self.host.data, target_is_directory=True)
        with self.assertRaises(ValueError):
            self.host.prune({revisions[0]})
        self.assertTrue(obsolete.is_symlink())
        self.assertEqual(
            (self.host.data / "messages").read_text(), "new messages must survive\n"
        )

    def test_duplicate_arrival_and_restart_never_repeat_activation(self):
        target = self.host.commit("src/console/view.ts", "two")
        self.loop.tick()
        self.loop.tick()
        self.assertEqual(self.store.get("active"), target)
        self.assertEqual(
            (self.host.data / "starts").read_text().splitlines(), [self.first, target]
        )
        self.assertEqual(
            (self.host.data / "messages").read_text(), "new messages must survive\n"
        )
        feed = json.loads(self.store.feed.read_text())
        self.assertEqual(
            [e["status"] for e in feed["events"]],
            ["received", "preparing", "activating", "healthy"],
        )
        self.assertNotIn("secret", self.store.feed.read_text().lower())
        self.assertLess(feed["events"][-1]["elapsedMs"], 30_000)
        print("successful warm fixture ms:", feed["events"][-1]["elapsedMs"])
        self.store.set("intent", target)
        root, feed_path = self.host.root, self.store.feed
        self.store.close()
        self.store = deploy.Store(root / "records", feed_path, self.first)
        deploy.Deployer(self.host, self.store).tick()
        self.assertEqual(self.store.get("blocked"), "activation_unknown")
        self.assertEqual(len((self.host.data / "starts").read_text().splitlines()), 2)
        deploy.Deployer(self.host, self.store).reconcile(target)
        self.assertFalse(self.store.get("blocked"))
        self.assertFalse(self.store.get("intent"))
        self.assertEqual(self.store.status(target), "reconciled")
        with (
            deploy.deployment_lock(root / "lock"),
            self.assertRaises(BlockingIOError),
            deploy.deployment_lock(root / "lock"),
        ):
            self.fail("second deployer acquired the same lock")

    def test_repeated_reconciliation_clears_new_ambiguity_and_survives_restart(self):
        self.loop.reconcile(self.first)
        original = json.loads(self.store.feed.read_text())["events"]
        self.loop.reconcile(self.first)
        self.assertEqual(json.loads(self.store.feed.read_text())["events"], original)

        target = self.host.commit("src/console/view.ts", "two")
        self.store.set("intent", target)
        root, feed_path = self.host.root, self.store.feed
        self.store.close()
        self.store = deploy.Store(root / "records", feed_path, self.first)
        self.loop = deploy.Deployer(self.host, self.store)
        self.assertEqual(self.store.get("blocked"), "activation_unknown")
        events = json.loads(feed_path.read_text())["events"]

        # A crash before SQLite commit must leave both ambiguity markers intact.
        self.store.db.execute("""
            CREATE TEMP TRIGGER interrupt_reconciliation BEFORE UPDATE ON state
            WHEN NEW.key='blocked' AND NEW.value=''
            BEGIN SELECT RAISE(ABORT, 'fixture interruption'); END
        """)
        with self.assertRaises(deploy.sqlite3.IntegrityError):
            self.loop.reconcile(self.first)
        self.assertEqual(self.store.get("intent"), target)
        self.assertEqual(self.store.get("blocked"), "activation_unknown")
        self.store.db.execute("DROP TRIGGER interrupt_reconciliation")

        # SQLite commits before feed publication; reopening repairs a stale feed.
        with (
            patch.object(self.store, "publish", side_effect=OSError("fixture")),
            self.assertRaises(OSError),
        ):
            self.loop.reconcile(self.first)
        self.assertFalse(self.store.get("intent"))
        self.assertFalse(self.store.get("blocked"))
        self.assertTrue(json.loads(feed_path.read_text())["blocked"])
        self.store.close()
        self.store = deploy.Store(root / "records", feed_path, self.first)
        self.assertFalse(json.loads(feed_path.read_text())["blocked"])
        self.loop = deploy.Deployer(self.host, self.store)
        self.loop.reconcile(self.first)
        feed = json.loads(feed_path.read_text())
        self.assertFalse(feed["blocked"])
        self.assertEqual(feed["lastHealthyRevision"], self.first)
        self.assertEqual(feed["events"], events)
        self.assertFalse(self.store.get("intent"))
        self.assertEqual(
            (self.host.data / "starts").read_text().splitlines(), [self.first]
        )

    def test_new_head_coalesces_and_force_push_cannot_reactivate_old_revision(self):
        stale = self.host.commit("src/console/view.ts", "two")
        newest = []
        self.host.after_prepare = lambda: newest.append(
            self.host.commit("src/console/view.ts", "three")
        )
        self.loop.tick()
        self.assertEqual(self.store.get("active"), self.first)
        self.loop.tick()
        self.assertEqual(self.store.get("active"), newest[0])
        self.host.git("reset", "--hard", stale)
        self.loop.tick()
        self.assertEqual(self.store.get("active"), newest[0])
        self.assertEqual(self.store.get("blocked"), "non_fast_forward")
        self.assertEqual(
            (self.host.data / "starts").read_text().splitlines(),
            [self.first, newest[0]],
        )

    def test_busy_workers_and_preflight_failure_preserve_current_and_changed_contract_can_forward(
        self,
    ):
        target = self.host.commit("src/console/view.ts", "two")
        (self.host.data / "busy").touch()
        self.loop.tick()
        self.assertEqual(self.store.get("active"), self.first)
        (self.host.data / "busy").unlink()
        self.loop.tick()
        self.assertEqual(self.store.get("active"), target)
        bad = self.host.commit("src/broken", "SECRET_FROM_BUILD")
        self.loop.tick()
        self.loop.tick()
        self.assertEqual(self.store.get("active"), target)
        self.assertEqual(self.store.status(bad), "failed")
        self.assertNotIn("SECRET", self.store.feed.read_text())
        (self.host.repo / "src/broken").unlink()
        incompatible = self.host.commit("src/runtime/registry.ts", "new journal layout")
        self.loop.tick()
        self.assertEqual(self.store.status(incompatible), "healthy")
        self.assertEqual(self.store.get("active"), incompatible)

    def test_bad_health_rolls_back_only_compatible_code_without_rewinding_data(self):
        target = self.host.commit("src/console/view.ts", "bad health")
        self.loop.tick()
        self.assertEqual(self.store.get("active"), self.first)
        self.assertEqual(self.store.status(target), "rolled_back")
        self.loop.tick()
        self.assertEqual(
            (self.host.data / "starts").read_text().splitlines(),
            [self.first, target, self.first],
        )
        self.assertEqual(
            (self.host.data / "messages").read_text(),
            "new messages must survive\ncandidate new message\n",
        )
        print(
            "failed warm fixture ms:",
            json.loads(self.store.feed.read_text())["events"][-1]["elapsedMs"],
        )
        fetch = self.host.fetch

        def offline():
            raise RuntimeError("secret fetch error")

        self.host.fetch = offline
        self.loop.tick()
        self.host.fetch = fetch
        self.loop.tick()
        self.assertEqual(
            (self.host.data / "starts").read_text().splitlines(),
            [self.first, target, self.first],
        )
        forward_bad = self.host.commit(
            "src/runtime/registry.ts", "forward-only new journal"
        )
        self.loop.tick()
        self.assertEqual(self.store.status(forward_bad), "blocked")
        self.assertEqual(self.store.get("blocked"), "unsafe_rollback")
        self.assertIsNone(self.host.process)


if __name__ == "__main__":
    unittest.main()
