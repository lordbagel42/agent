"""Core safety checks. All Git, HTTP service and durable data are disposable."""

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
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
        subprocess.run(
            [
                sys.executable,
                "-c",
                "import ast,pathlib; ast.parse(pathlib.Path('src/service.py').read_text())",
            ],
            cwd=stage,
            check=True,
        )

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

    def test_github_status_tracks_deployments_without_reposting_busy_polls(self):
        published = []
        reporter = deploy.GitHubStatuses(self.store)
        self.loop = deploy.Deployer(self.host, self.store, reporter)

        def accept(request, timeout):
            self.assertEqual(timeout, 5)
            self.assertEqual(request.get_method(), "POST")
            self.assertEqual(
                request.get_header("Authorization"), "Bearer fixture-token"
            )
            self.assertEqual(
                request.get_header("Accept"), "application/vnd.github+json"
            )
            self.assertTrue(
                request.full_url.startswith(
                    "https://api.github.com/repos/lordbagel42/agent/statuses/"
                )
            )
            body = json.loads(request.data)
            self.assertEqual(body["context"], "june/deploy")
            self.assertNotIn("SECRET", request.data.decode())
            self.assertNotIn("target_url", body)
            published.append((request.full_url.rsplit("/", 1)[1], body["state"]))
            return response

        with (
            patch.object(deploy, "private_file", return_value="fixture-token\n"),
            patch.object(reporter.opener, "open") as send,
        ):
            response = send.return_value
            response.__enter__.return_value.status = 201
            send.side_effect = accept
            target = self.host.commit("src/console/view.ts", "two")
            (self.host.data / "busy").touch()
            self.loop.tick()
            self.loop.tick()
            self.assertEqual(published, [(target, "pending")])
            (self.host.data / "busy").unlink()
            self.loop.tick()
            self.loop.tick()
            self.assertEqual(published, [(target, "pending"), (target, "success")])
            failed = self.host.commit("src/console/view.ts", "bad health")
            self.loop.tick()
            self.assertEqual(published[-2:], [(failed, "pending"), (failed, "failure")])
            self.assertTrue(self.host.running(target))
            self.store.event(failed, "fetch_failed", "fetch_failed")
            self.loop.tick()
            self.assertEqual(published[-1], (failed, "failure"))
            skipped = self.host.commit("src/console/view.ts", "three")
            newest = self.host.commit("src/console/view.ts", "four")
            self.loop.tick()
            self.assertIn((skipped, "error"), published)
            self.assertEqual(published[-1], (newest, "success"))

    def test_github_outage_keeps_deploying_and_retries_latest_status_after_restart(
        self,
    ):
        target = self.host.commit("src/console/view.ts", "two")
        reporter = deploy.GitHubStatuses(self.store)
        self.loop = deploy.Deployer(self.host, self.store, reporter)
        with (
            patch.object(deploy, "private_file", return_value="fixture-token"),
            patch.object(
                reporter.opener,
                "open",
                side_effect=deploy.urllib.error.URLError("SECRET"),
            ),
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
            patch.object(reporter.opener, "open") as send,
        ):
            send.return_value.__enter__.return_value.status = 201
            self.loop.tick()
            self.loop.tick()
            self.assertEqual(len(send.call_args_list), 1)
            self.assertEqual(
                json.loads(send.call_args.args[0].data)["state"], "success"
            )
        self.assertEqual(
            (self.host.data / "starts").read_text().splitlines(), [self.first, target]
        )

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
