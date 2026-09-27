"""Core safety checks. All Git, HTTP service and durable data are disposable."""

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

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
        root = Path(self.tmp.name)
        self.host = FixtureHost(root)
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
