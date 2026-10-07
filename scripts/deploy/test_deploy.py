"""Core safety checks. All Git, HTTP service and durable data are disposable."""

import base64
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
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

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
        body = {"name": "June", "revision": release["revision"], "ready": not Path("src/console/view.ts").read_text().startswith("bad") and not (data / "latch").exists()}
        if (data / "latch").exists(): body["failure"] = "lease_abort"
        self.send_response(200 if body["ready"] else 503); self.end_headers()
        self.wfile.write(json.dumps(body).encode())
    def do_POST(self):
        with (data / "drains").open("a") as f: f.write(release["revision"] + "\\n")
        self.send_response(409 if (data / "busy").exists() else 200); self.end_headers()
        self.wfile.write(json.dumps({"revision": release["revision"], "drained": not (data / "busy").exists()}).encode())
    def do_DELETE(self):
        with (data / "resumes").open("a") as f: f.write(release["revision"] + "\\n")
        self.send_response(200); self.end_headers()
        self.wfile.write(json.dumps({"revision": release["revision"], "drained": False}).encode())
HTTPServer.allow_reuse_address = True
HTTPServer(("127.0.0.1", int(os.environ["PORT"])), Handler).serve_forever()
"""


RUNNING_SERVICE = {
    "LoadState": "loaded",
    "ActiveState": "active",
    "SubState": "running",
    "Result": "success",
    "MainPID": "101",
    "ControlPID": "0",
    "ExecMainPID": "101",
    "ExecMainCode": "0",
    "ExecMainStatus": "0",
    "ExecMainStartTimestampMonotonic": "1000000",
    "ExecMainExitTimestampMonotonic": "0",
    "InvocationID": "1234567890abcdef1234567890abcdef",
    "Job": "",
}
STOPPED_SERVICE = {
    **RUNNING_SERVICE,
    "ActiveState": "inactive",
    "SubState": "dead",
    "MainPID": "0",
    "ExecMainCode": "1",  # CLD_EXITED, not a signal accepted by SuccessExitStatus.
    "ExecMainExitTimestampMonotonic": "3000000",
}


def service_output(state):
    return "\n".join(f"{key}={value}" for key, value in state.items()).encode()


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
            # Includes Python process startup on shared runners, not just HTTP.
            "healthSeconds": 3,
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

    def runtime_identity(self, commit):
        if not self.running(commit):
            raise ValueError("runtime_identity_unknown")
        return {"fixturePid": self.process.pid}


class GitHubFixture:
    def __init__(self, token="fixture-token"):
        self.token = token
        self.runs = {}
        self.statuses = []
        self.writes = []
        self.lose_create_response = False

    def open(self, request, timeout):
        assert timeout == 5
        assert request.get_header("Authorization") == "Bearer " + self.token
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
                "app": {"id": 123},
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


class GitHubAppAuthentication(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.key = self.root / "app.pem"
        subprocess.run(
            ["openssl", "genrsa", "-out", str(self.key), "2048"],
            check=True,
            capture_output=True,
        )
        self.app = {
            "appId": 123,
            "installationId": 456,
            "privateKeyFile": str(self.key),
        }
        self.store = deploy.Store(self.root / "records", self.root / "feed", "a" * 40)
        self.addCleanup(self.store.close)
        self.store.event("a" * 40, "healthy")
        self.api = GitHubFixture("ghs_" + "a" * 180 + "." + "b" * 180 + "." + "c" * 180)
        self.installation = {
            "id": 456,
            "app_id": 123,
            "account": {"login": "lordbagel42"},
        }
        self.grant = {
            "token": self.api.token,
            "expires_at": "2030-01-01T01:00:00Z",
            "permissions": {"checks": "write", "statuses": "write", "metadata": "read"},
            "repositories": [{"full_name": "lordbagel42/agent"}],
        }
        self.mints = 0

    def open(self, request, timeout):
        url = request.full_url
        if url.endswith(("/installation", "/access_tokens")):
            jwt = request.get_header("Authorization").removeprefix("Bearer ")
            header, claims, signature = jwt.split(".")
            decode = lambda part: base64.urlsafe_b64decode(
                part + "=" * (-len(part) % 4)
            )
            self.assertEqual(json.loads(decode(header)), {"alg": "RS256", "typ": "JWT"})
            claims = json.loads(decode(claims))
            self.assertEqual(claims["iss"], "123")
            self.assertEqual(claims["iat"], int(deploy.time.time()) - 60)
            self.assertEqual(claims["exp"], int(deploy.time.time()) + 540)
            public = self.root / "public.pem"
            subprocess.run(
                [
                    "openssl",
                    "rsa",
                    "-in",
                    str(self.key),
                    "-pubout",
                    "-out",
                    str(public),
                ],
                check=True,
                capture_output=True,
            )
            signed = self.root / "signature"
            signed.write_bytes(decode(signature))
            subprocess.run(
                [
                    "openssl",
                    "dgst",
                    "-sha256",
                    "-verify",
                    str(public),
                    "-signature",
                    str(signed),
                ],
                input=jwt.rsplit(".", 1)[0].encode(),
                check=True,
                capture_output=True,
            )
            if url.endswith("/installation"):
                self.assertEqual(
                    url, "https://api.github.com/repos/lordbagel42/agent/installation"
                )
                self.assertEqual(request.get_method(), "GET")
                result = self.installation
            else:
                self.assertEqual(
                    url, "https://api.github.com/app/installations/456/access_tokens"
                )
                self.assertEqual(request.get_method(), "POST")
                self.assertEqual(
                    json.loads(request.data),
                    {
                        "repositories": ["agent"],
                        "permissions": {"checks": "write", "statuses": "write"},
                    },
                )
                self.mints += 1
                result = self.grant
            response = io.BytesIO(json.dumps(result).encode())
            response.status = 201 if request.get_method() == "POST" else 200
            return response
        return self.api.open(request, timeout)

    def test_scoped_app_token_signs_refreshes_and_publishes_details(self):
        reporter = deploy.GitHubStatuses(self.store, app=self.app)
        self.store.set("github-status:" + "a" * 40, '{"state":"pending"}')
        with (
            patch.object(deploy, "private_file", return_value=self.key.read_text()),
            patch.object(reporter.opener, "open", side_effect=self.open),
            patch.object(deploy.time, "time", return_value=1893456000) as clock,
        ):
            reporter.flush()
            self.assertEqual(self.api.runs[41]["conclusion"], "success")
            self.assertEqual(
                self.api.statuses[-1]["target_url"],
                "https://github.com/lordbagel42/agent/runs/41",
            )
            clock.return_value += 3539
            reporter.flush()
            self.assertEqual(self.mints, 1)
            clock.return_value += 1
            self.grant["expires_at"] = "2030-01-01T02:00:00Z"
            reporter.flush()
            self.assertEqual(self.mints, 2)
        self.assertNotIn(self.api.token, self.store.feed.read_text())
        self.assertNotIn(
            self.api.token,
            str([tuple(row) for row in self.store.db.execute("SELECT * FROM state")]),
        )

    def test_report_only_preserves_fenced_lifecycle_and_rejects_incomplete_state(self):
        self.store.set("recovery", '{"incident":738,"phase":"claimed"}')
        self.store.set("operatorHold", "fixture-owner")
        self.store.set("queue", '{"tip":"' + "a" * 40 + '","pending":[]}')
        baseline = list(
            self.store.db.execute(
                "SELECT * FROM state WHERE key NOT LIKE 'github-%' ORDER BY key"
            )
        )
        events = list(self.store.db.execute("SELECT * FROM events"))
        feed = self.store.feed.read_bytes()
        config = {
            "origin": "http://127.0.0.1:3080",
            "healthSeconds": 15,
            "initialRevision": "a" * 40,
            "githubApp": self.app,
            "ampRecovery": True,
        }
        paths = {
            "/var/lib/june-deploy/records": self.root / "records",
            "/var/lib/june-deploy/public/events.json": self.store.feed,
        }
        real_lstat = Path.lstat

        def root_stat(path, *args, **kwargs):
            values = list(real_lstat(path, *args, **kwargs))
            values[4] = 0
            return os.stat_result(values)

        with (
            patch.object(sys, "argv", ["deploy.py", "--report-only"]),
            patch.object(deploy.os, "geteuid", return_value=0),
            patch.object(deploy, "private_file", return_value=json.dumps(config)),
            patch.object(
                deploy, "Path", side_effect=lambda value: paths.get(value, self.root)
            ),
            patch.object(Path, "lstat", root_stat),
            patch.object(
                deploy.pwd, "getpwnam", return_value=SimpleNamespace(pw_gid=os.getgid())
            ),
            patch.object(deploy, "deployment_lock", return_value=nullcontext()),
            patch.object(
                deploy, "Host", side_effect=AssertionError("no host operations")
            ),
            patch.object(
                deploy,
                "Deployer",
                side_effect=AssertionError("no deployment operations"),
            ),
            patch.object(
                deploy.Store, "publish", side_effect=AssertionError("no feed writes")
            ),
            patch.object(
                deploy.Recovery,
                "record",
                side_effect=AssertionError("no recovery writes"),
            ),
            patch.object(
                deploy.GitHubApp, "token", return_value=self.api.token
            ) as token,
            patch.object(deploy.urllib.request, "build_opener", return_value=self.api),
        ):
            deploy.main()
            token.side_effect = ValueError("unavailable")
            with self.assertRaisesRegex(ValueError, "github_reporting_incomplete"):
                deploy.main()
            self.assertEqual(
                list(
                    self.store.db.execute(
                        "SELECT * FROM state WHERE key NOT LIKE 'github-%' ORDER BY key"
                    )
                ),
                baseline,
            )
            self.assertEqual(
                list(self.store.db.execute("SELECT * FROM events")), events
            )
            self.assertEqual(self.store.feed.read_bytes(), feed)
            with self.store.db:
                self.store.db.execute("DELETE FROM state WHERE key='observed'")
            with self.assertRaisesRegex(ValueError, "invalid_revision"):
                deploy.main()
            self.assertEqual(self.store.get("observed"), "")

    def test_wrong_installation_or_broader_grant_never_publishes_or_falls_back(self):
        for wrong in (
            "account",
            "installation",
            "repository",
            "permission",
            "expiry",
            "unsafe_token",
            "missing_key",
        ):
            with self.subTest(wrong=wrong):
                reporter = deploy.GitHubStatuses(self.store, app=self.app)
                installation = json.loads(json.dumps(self.installation))
                grant = json.loads(json.dumps(self.grant))
                if wrong == "account":
                    self.installation["account"]["login"] = "someone-else"
                if wrong == "installation":
                    self.installation["id"] = 789
                if wrong == "repository":
                    self.grant["repositories"].append(
                        {"full_name": "lordbagel42/other"}
                    )
                if wrong == "permission":
                    self.grant["permissions"]["contents"] = "write"
                if wrong == "expiry":
                    self.grant["expires_at"] = "2029-12-31T23:00:00Z"
                if wrong == "unsafe_token":
                    self.grant["token"] = "unsafe\r\nHeader: value"
                paths = []

                def private(path, paths=paths, wrong=wrong):
                    paths.append(path)
                    if wrong == "missing_key":
                        raise FileNotFoundError()
                    return self.key.read_text()

                with (
                    patch.object(deploy, "private_file", side_effect=private),
                    patch.object(reporter.opener, "open", side_effect=self.open),
                    patch.object(deploy.time, "time", return_value=1893456000),
                    patch("sys.stdout", new_callable=io.StringIO) as output,
                ):
                    reporter.flush()
                self.assertEqual(
                    output.getvalue(), "github_status_publish_failed: will retry\n"
                )
                self.assertEqual(self.api.runs, {})
                self.assertEqual(self.api.statuses, [])
                self.assertEqual(paths, [self.key])
                self.installation, self.grant = installation, grant

    def test_invalid_config_and_revoked_token_fail_closed_then_retry(self):
        for app in (
            None,
            {},
            False,
            {**self.app, "appId": True},
            {**self.app, "installationId": "456"},
            {**self.app, "privateKeyFile": "relative.pem"},
        ):
            with (
                self.subTest(app=app),
                patch.object(
                    deploy,
                    "private_file",
                    side_effect=AssertionError("must not read PAT"),
                ) as private,
                patch("sys.stdout", new_callable=io.StringIO) as output,
            ):
                reporter = deploy.GitHubStatuses(self.store, app=app)
                with patch.object(reporter.opener, "open") as network:
                    reporter.flush()
                private.assert_not_called()
                network.assert_not_called()
                self.assertEqual(
                    output.getvalue(), "github_status_publish_failed: will retry\n"
                )
        reporter = deploy.GitHubStatuses(self.store, app=self.app)
        with (
            patch.object(deploy, "private_file", return_value=self.key.read_text()),
            patch.object(reporter.opener, "open", side_effect=self.open) as transport,
            patch.object(deploy.time, "time", return_value=1893456000),
            patch.object(deploy.time, "monotonic", return_value=100) as clock,
            patch("sys.stdout", new_callable=io.StringIO) as output,
        ):
            reporter.flush()
            self.assertEqual(self.api.runs[41]["conclusion"], "success")
            self.store.event("a" * 40, "failed")
            transport.side_effect = deploy.urllib.error.HTTPError(
                "https://api.github.com/",
                401,
                "private error",
                {},
                io.BytesIO(b"SECRET"),
            )
            reporter.flush()
            self.assertEqual(
                output.getvalue(), "github_status_publish_failed: will retry\n"
            )
            transport.side_effect = self.open
            clock.return_value = 159
            reporter.flush()
            self.assertEqual(self.mints, 1)
            clock.return_value = 160
            reporter.flush()
            self.assertEqual(self.mints, 2)
            self.assertEqual(self.api.runs[41]["conclusion"], "failure")


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


class ServiceStopSafety(unittest.TestCase):
    def test_exec_stop_pins_main_and_rejects_unknown_identity_or_timeout(self):
        stopping = {
            **RUNNING_SERVICE,
            "ControlPID": str(os.getpid()),
            "ActiveState": "deactivating",
            "SubState": "stop",
        }
        for name, before, after, exited, error, sends in (
            ("normal", stopping, stopping, True, None, True),
            ("timeout", stopping, stopping, False, "stop_helper_timeout", True),
            (
                "not-control",
                {**stopping, "ControlPID": "999999"},
                stopping,
                True,
                "stop_helper_context_unknown",
                False,
            ),
            (
                "wrong-main",
                {**stopping, "MainPID": "102"},
                stopping,
                True,
                "stop_helper_identity_unknown",
                False,
            ),
            (
                "invocation-changed",
                stopping,
                {**stopping, "InvocationID": "f" * 32},
                True,
                "stop_helper_identity_changed",
                False,
            ),
            (
                "main-changed",
                stopping,
                {**stopping, "MainPID": "102"},
                True,
                "stop_helper_identity_changed",
                False,
            ),
            ("cwd", stopping, stopping, True, "stop_helper_identity_changed", False),
            ("cgroup", stopping, stopping, True, "stop_helper_identity_changed", False),
            (
                "already-exited",
                {**stopping, "MainPID": "0"},
                stopping,
                True,
                None,
                False,
            ),
        ):
            with (
                self.subTest(name=name),
                patch.dict(
                    os.environ,
                    {"MAINPID": "101", "INVOCATION_ID": stopping["InvocationID"]},
                ),
                patch.object(
                    deploy.subprocess,
                    "check_output",
                    side_effect=[service_output(before), service_output(after)],
                ),
                patch.object(deploy.os, "pidfd_open", return_value=17) as opened,
                patch.object(deploy.os, "close") as closed,
                patch.object(deploy.signal, "pidfd_send_signal") as sent,
                patch.object(deploy.select, "poll") as poll,
                patch.object(
                    Path,
                    "resolve",
                    return_value=Path(
                        "/tmp/not-a-release"
                        if name == "cwd"
                        else "/opt/june/releases/" + "a" * 40
                    ),
                ),
                patch.object(
                    Path,
                    "read_bytes",
                    side_effect=[
                        b"0::/system.slice/other.service\n"
                        if name == "cgroup"
                        else b"0::/system.slice/june.service\n",
                        b"0::/system.slice/june.service\n",
                    ],
                ),
            ):
                poll.return_value.poll.return_value = (
                    [(17, deploy.select.POLLIN)] if exited else []
                )
                if error:
                    with self.assertRaisesRegex(ValueError, error):
                        deploy.stop_app()
                else:
                    deploy.stop_app()
                if sends:
                    opened.assert_called_once_with(101)
                    sent.assert_called_once_with(17, signal.SIGTERM)
                    poll.return_value.register.assert_called_once_with(
                        17, deploy.select.POLLIN
                    )
                    self.assertLessEqual(
                        poll.return_value.poll.call_args.args[0], 45_000
                    )
                else:
                    sent.assert_not_called()
                if opened.called:
                    closed.assert_called_once_with(17)

    def test_exec_stop_mode_never_enters_deployment_lock_or_root_configuration(self):
        with (
            patch.object(sys, "argv", ["deploy.py", "--stop-app"]),
            patch.object(deploy, "stop_app") as stop,
            patch.object(
                deploy, "private_file", side_effect=AssertionError("config read")
            ),
            patch.object(
                deploy, "deployment_lock", side_effect=AssertionError("recursive lock")
            ),
            patch.object(deploy.os, "geteuid", return_value=999),
        ):
            deploy.main()
        stop.assert_called_once_with()

    def test_stop_requires_retained_matching_normal_exit_not_only_job_success(self):
        host = object.__new__(deploy.Host)
        cases = [
            ({}, True),
            ({"InvocationID": ""}, True),  # Retained process record still required.
            ({"InvocationID": "", "ExecMainPID": "102"}, False),
            ({"InvocationID": "", "ExecMainStartTimestampMonotonic": "1100000"}, False),
            ({"InvocationID": "", "ExecMainExitTimestampMonotonic": "0"}, False),
            ({"InvocationID": "", "ExecMainExitTimestampMonotonic": "1500000"}, False),
            ({"Result": "timeout"}, False),  # Even when the main process exited 0.
            ({"Result": "exit-code"}, False),  # Failed ExecStop, normal main exit.
            ({"Result": "signal", "ExecMainCode": "2", "ExecMainStatus": "9"}, False),
            ({"ExecMainCode": "2", "ExecMainStatus": "15"}, False),
            ({"ExecMainStatus": "1"}, False),
            ({"ExecMainPID": "102"}, False),
            ({"ExecMainStartTimestampMonotonic": "1100000"}, False),
            ({"ExecMainExitTimestampMonotonic": "0"}, False),
            ({"ExecMainExitTimestampMonotonic": "1500000"}, False),
            ({"ExecMainExitTimestampMonotonic": ""}, False),
            ({"InvocationID": "abcdef1234567890abcdef1234567890"}, False),
            ({"ActiveState": "failed"}, False),
            ({"SubState": "failed"}, False),
            ({"MainPID": "102"}, False),
            ({"ControlPID": "103"}, False),
            ({"Job": "71"}, False),
            ({"LoadState": "not-found"}, False),
        ]
        for changed, clean in cases:
            with (
                self.subTest(changed=changed),
                patch.object(deploy.time, "monotonic_ns", return_value=2_000_000_000),
                patch.object(
                    deploy.subprocess,
                    "check_output",
                    side_effect=[
                        service_output(RUNNING_SERVICE),
                        service_output({**STOPPED_SERVICE, **changed}),
                    ],
                ),
                patch.object(deploy.subprocess, "run") as manager,
            ):
                if clean:
                    host.service("stop")
                else:
                    with self.assertRaises(ValueError):
                        host.service("stop")
                self.assertEqual(
                    [call.args[0] for call in manager.call_args_list],
                    [["systemctl", "stop", "june.service"]],
                )
        for changed in (
            {"InvocationID": ""},
            {"MainPID": "0"},
            {"ExecMainPID": "102"},
            {"ExecMainStartTimestampMonotonic": "0"},
            {"ExecMainExitTimestampMonotonic": "1500000"},
            {"Job": "71"},
        ):
            with (
                self.subTest(before=changed),
                patch.object(
                    deploy.subprocess,
                    "check_output",
                    return_value=service_output({**RUNNING_SERVICE, **changed}),
                ),
                patch.object(deploy.subprocess, "run") as manager,
                self.assertRaises(ValueError),
            ):
                try:
                    host.service("stop")
                finally:
                    manager.assert_not_called()
        for unavailable in (
            service_output({k: v for k, v in STOPPED_SERVICE.items() if k != "Result"}),
            b"not a property record",
            subprocess.TimeoutExpired("systemctl show", 5),
            subprocess.CalledProcessError(1, "systemctl show"),
        ):
            with (
                self.subTest(unavailable=unavailable),
                patch.object(deploy.time, "monotonic_ns", return_value=2_000_000_000),
                patch.object(
                    deploy.subprocess,
                    "check_output",
                    side_effect=[service_output(RUNNING_SERVICE), unavailable],
                ),
                patch.object(deploy.subprocess, "run") as manager,
            ):
                with self.assertRaises((ValueError, subprocess.SubprocessError)):
                    host.service("stop")
                manager.assert_called_once()
        with (
            patch.object(deploy.subprocess, "check_output") as evidence,
            patch.object(deploy.subprocess, "run") as manager,
        ):
            host.service("start")
            evidence.assert_not_called()
            manager.assert_called_once_with(
                ["systemctl", "start", "june.service"],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=True,
            )


class RecoverySafety(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.revision = "a" * 40
        self.thread = "T-11111111-2222-3333-4444-555555555555"
        self.store = deploy.Store(
            self.root / "records", self.root / "feed.json", self.revision
        )
        self.addCleanup(self.store.close)
        self.recovery = deploy.Recovery(self.store)
        self.recovery.flush()
        self.config = {
            "ampRecovery": {
                "command": ["/fixture/amp"],
                "runnerDirectory": "/workspace",
            }
        }

    def incident(self):
        self.store.event("b" * 40, "failed", "preflight_failed")
        with patch.object(deploy.subprocess, "run"):
            self.recovery.flush()
        return json.loads(self.store.get("recovery"))["incident"]

    def test_source_admission_is_metadata_only_and_survives_reconciliation(self):
        for admission in (
            self.incident,
            lambda: self.recovery.record("controller_failed"),
        ):
            admission()
            incident = json.loads(self.store.get("recovery"))
            key = f"issue-source:recovery:{incident['incident']}"
            self.assertTrue(self.store.get(key))
            source = json.loads(self.store.get(key))
            self.assertEqual(
                source,
                {
                    "source": f"recovery:{incident['incident']}",
                    "phase": "queued",
                    "revision": incident["revision"],
                },
            )
            incident.update(phase="spawned", thread=self.thread)
            self.store.set("recovery", json.dumps(incident))
            self.recovery.claim(incident["incident"], self.thread)
            host = Mock()
            deploy.Deployer(host, self.store).reconcile(self.revision, self.thread)
            self.assertEqual(self.store.get("recovery"), "")
            source = json.loads(self.store.get(key))
            # Readiness/ownership is NOT evidence that an Amp turn returned.
            self.assertEqual(source["phase"], "running")
            self.assertEqual(source["threadId"], self.thread)

    def test_source_return_requires_matching_single_terminal_and_successful_exit(self):
        init = {"type": "system", "subtype": "init", "session_id": self.thread}
        result = {
            "type": "result",
            "session_id": self.thread,
            "is_error": False,
            "result": "PRIVATE_RESULT",
        }
        for messages, code, expected in (
            ([init, result], 0, "returned"),
            ([init, result], 1, "unknown"),
            ([init], 0, "unknown"),
            ([result], 0, "unknown"),
            (
                [
                    init,
                    {**result, "session_id": "T-99999999-2222-3333-4444-555555555555"},
                ],
                0,
                "unknown",
            ),
            ([init, {**result, "is_error": True}], 0, "unknown"),
            ([init, result, result], 0, "unknown"),
            ([init, init, result], 0, "unknown"),
        ):
            with self.subTest(messages=messages, code=code):
                self.recovery.record("controller_failed")
                number = json.loads(self.store.get("recovery"))["incident"]
                fake = Mock()
                fake.__enter__ = Mock(return_value=fake)
                fake.__exit__ = Mock(return_value=False)
                fake.wait.return_value = code

                def stream(messages=messages):
                    for message in messages:
                        yield json.dumps(message) + "\n"
                    # The dispatcher must retain metadata even if recovery is
                    # cleared while the same observer is still draining output.
                    self.store.set("recovery", "")

                fake.stdout = stream()
                with patch.object(deploy.subprocess, "Popen", return_value=fake):
                    deploy.dispatch_recovery(
                        self.config, number, self.root / "records/deploy.sqlite"
                    )
                raw = self.store.get(f"issue-source:recovery:{number}")
                self.assertTrue(raw)
                source = json.loads(raw)
                self.assertEqual(source["phase"], expected)
                self.assertNotIn("PRIVATE", raw)
                if messages[0] == init:
                    self.assertEqual(source["threadId"], self.thread)

    def test_source_updates_never_commit_caller_transactions_or_regress(self):
        self.assertTrue(hasattr(deploy, "record_recovery_source"))
        incident = {"incident": 12, "revision": self.revision}
        key = "issue-source:recovery:12"
        deploy.record_recovery_source(self.store.db, incident, "running", self.thread)
        self.store.db.execute("BEGIN IMMEDIATE")
        self.store.db.execute("INSERT INTO state VALUES ('uncommitted','private')")
        deploy.record_recovery_source(self.store.db, incident, "returned", self.thread)
        self.assertTrue(self.store.db.in_transaction)
        self.store.db.rollback()
        self.assertEqual(self.store.get("uncommitted"), "")
        self.assertEqual(json.loads(self.store.get(key))["phase"], "running")
        deploy.record_recovery_source(self.store.db, incident, "returned", self.thread)
        deploy.record_recovery_source(self.store.db, incident, "queued")
        deploy.record_recovery_source(self.store.db, incident, "unknown")
        self.assertEqual(
            json.loads(self.store.get(key)),
            {
                "source": "recovery:12",
                "phase": "returned",
                "revision": self.revision,
                "threadId": self.thread,
            },
        )

    def test_source_late_thread_links_without_regressing_unknown_or_rebinding(self):
        incident = {"incident": 23, "revision": self.revision}
        deploy.record_recovery_source(self.store.db, incident, "unknown")
        deploy.record_recovery_source(self.store.db, incident, "running", self.thread)
        expected = {
            "source": "recovery:23",
            "phase": "unknown",
            "revision": self.revision,
            "threadId": self.thread,
        }
        self.assertEqual(
            json.loads(self.store.get("issue-source:recovery:23")), expected
        )
        deploy.record_recovery_source(
            self.store.db,
            incident,
            "returned",
            "T-99999999-2222-3333-4444-555555555555",
        )
        self.assertEqual(
            json.loads(self.store.get("issue-source:recovery:23")), expected
        )

    def test_source_storage_failure_never_blocks_dispatch(self):
        self.assertTrue(hasattr(deploy, "record_recovery_source"))
        self.store.db.execute("""CREATE TRIGGER source_unavailable BEFORE INSERT ON state
            WHEN NEW.key LIKE 'issue-source:%' BEGIN SELECT RAISE(FAIL, 'private'); END""")
        number = self.incident()
        with (
            patch.object(deploy.subprocess, "Popen", side_effect=OSError("private")),
            self.assertRaises(OSError),
        ):
            deploy.dispatch_recovery(
                self.config, number, self.root / "records/deploy.sqlite"
            )
        self.assertEqual(json.loads(self.store.get("recovery"))["phase"], "dispatching")
        self.assertEqual(self.store.get(f"issue-source:recovery:{number}"), "")

    def test_dispatch_receipt_is_durable_private_and_never_recreated(self):
        number = self.incident()
        self.config["ampRecovery"]["ssh"] = ["/usr/bin/ssh", "fixture-runner"]
        self.config["ampRecovery"]["runnerDirectory"] = "/workspace/it's June; $HOME"
        fake = Mock()
        fake.__enter__ = Mock(return_value=fake)
        fake.__exit__ = Mock(return_value=False)
        fake.stdout = io.StringIO(
            json.dumps({"type": "system", "subtype": "init", "session_id": self.thread})
            + '\n{"type":"assistant","text":"PRIVATE"}\n'
        )
        with patch.object(deploy.subprocess, "Popen", return_value=fake) as spawn:
            deploy.dispatch_recovery(
                self.config, number, self.root / "records/deploy.sqlite"
            )
            deploy.dispatch_recovery(
                self.config, number, self.root / "records/deploy.sqlite"
            )
            self.assertEqual(spawn.call_count, 1)
            invocation = spawn.call_args.args[0]
            self.assertEqual(invocation[:2], ["/usr/bin/ssh", "fixture-runner"])
            self.assertEqual(len(invocation), 3)
            args = deploy.shlex.split(invocation[2])
            self.assertEqual(args[args.index("--mode") + 1], "ultra")
            self.assertEqual(args[args.index("--features") + 1], "fast")
            self.assertEqual(args[args.index("--executor") + 1], "runner:homelab-amp")
            self.assertEqual(args[-2], "--execute")
            self.assertTrue(args[-1].startswith("June deployment failed."))
            self.assertEqual(
                args[args.index("--runner-dir") + 1], "/workspace/it's June; $HOME"
            )
        self.assertEqual(json.loads(self.store.get("recovery"))["thread"], self.thread)
        self.assertNotIn("PRIVATE", self.store.get("recovery"))
        self.assertNotIn(self.thread, (self.root / "feed.json").read_text())
        host = Mock()
        deploy.Deployer(host, self.store, recovery=self.recovery).tick()
        host.prepare.assert_not_called()
        host.fetch.assert_not_called()
        with self.assertRaisesRegex(ValueError, "recovery_claim_denied"):
            self.recovery.claim(number + 1, self.thread)
        with self.assertRaisesRegex(ValueError, "recovery_claim_denied"):
            self.recovery.claim(number, "T-99999999-2222-3333-4444-555555555555")
        self.recovery.claim(number, self.thread)
        loop = deploy.Deployer(host, self.store)
        with self.assertRaisesRegex(ValueError, "recovery_owner_required"):
            loop.reconcile(self.revision)
        host.healthy.return_value = False
        with self.assertRaisesRegex(ValueError, "reconciliation_not_ready"):
            loop.reconcile(self.revision, self.thread)
        self.assertTrue(self.store.get("recovery"))
        host.healthy.return_value = True
        loop.reconcile(self.revision, self.thread)
        self.recovery.flush()
        self.assertEqual(self.store.get("recovery"), "")
        # A second candidate failure can reconcile to the SAME running SHA.
        # Its receipt must still fence off this newer incident permanently.
        self.store.event("c" * 40, "failed", "preflight_failed")
        with patch.object(deploy.subprocess, "run"):
            self.recovery.flush()
        second = json.loads(self.store.get("recovery"))
        second.update(phase="spawned", thread=self.thread)
        self.store.set("recovery", json.dumps(second))
        self.recovery.claim(second["incident"], self.thread)
        loop.reconcile(self.revision, self.thread)
        with patch.object(deploy.subprocess, "run") as start:
            self.recovery.flush()
            start.assert_not_called()
        self.assertEqual(self.store.get("recovery"), "")

    def test_unknown_creation_survives_reopen_without_retry(self):
        number = self.incident()
        with patch.object(
            deploy.subprocess, "Popen", side_effect=OSError("private")
        ) as spawn:
            with self.assertRaises(OSError):
                deploy.dispatch_recovery(
                    self.config, number, self.root / "records/deploy.sqlite"
                )
            deploy.dispatch_recovery(
                self.config, number, self.root / "records/deploy.sqlite"
            )
            self.assertEqual(spawn.call_count, 1)
        self.assertEqual(json.loads(self.store.get("recovery"))["phase"], "dispatching")
        raw = self.store.get(f"issue-source:recovery:{number}")
        self.assertTrue(raw)
        self.assertEqual(json.loads(raw)["phase"], "unknown")
        with patch.object(deploy.subprocess, "run") as start:
            self.recovery.flush()
            start.assert_not_called()

    def test_optional_issue_tracker_failure_never_blocks_recovery_or_changes_policy(
        self,
    ):
        number = self.incident()
        self.config["issueTracker"] = {
            "origin": "http://not-allowed.invalid",
            "tokenFile": str(self.root / "missing-token"),
        }
        fake = Mock()
        fake.__enter__ = Mock(return_value=fake)
        fake.__exit__ = Mock(return_value=False)
        fake.stdout = io.StringIO("")
        with patch.object(deploy.subprocess, "Popen", return_value=fake) as spawn:
            deploy.dispatch_recovery(
                self.config, number, self.root / "records/deploy.sqlite"
            )
        argv = spawn.call_args.args[0]
        self.assertEqual(argv[1:5], ["--mode", "ultra", "--features", "fast"])
        self.assertIn(f'"source":"recovery:{number}"', argv[-1])
        self.assertIn("/usr/local/lib/june-deploy/issues.py tool", argv[-1])
        self.assertIn("explicit operator authorization", argv[-1])
        self.assertIn("Require an Oracle review", argv[-1])
        self.assertEqual(json.loads(self.store.get("recovery"))["phase"], "dispatching")

    def test_operator_hold_fences_pending_dispatch_and_claim(self):
        number = self.incident()
        self.store.set("operatorHold", "existing-operator")
        with (
            patch.object(deploy.subprocess, "run") as start,
            patch.object(deploy.subprocess, "Popen") as spawn,
        ):
            self.recovery.flush()
            deploy.dispatch_recovery(
                self.config, number, self.root / "records/deploy.sqlite"
            )
            start.assert_not_called()
            spawn.assert_not_called()
        with self.assertRaisesRegex(ValueError, "recovery_claim_denied"):
            self.recovery.claim(number, self.thread)
        self.assertEqual(json.loads(self.store.get("recovery"))["phase"], "pending")

    def test_legacy_failure_requires_explicit_handoff(self):
        self.store.set("recoveryInitialized", "")
        self.store.block("b" * 40, "activation_unknown")
        with patch.object(deploy.subprocess, "run") as start:
            self.recovery.flush()
            self.recovery.flush()
            start.assert_not_called()
        self.assertEqual(self.store.get("operatorHold"), "legacy-recovery")
        self.assertEqual(self.store.get("recovery"), "")

    def test_transient_events_do_not_create_incidents_but_blocks_do(self):
        for status, reason in (
            ("fetch_failed", "fetch_failed"),
            ("deferred", "insufficient_disk"),
            ("deferred", "drain_busy"),
        ):
            with self.subTest(reason=reason):
                self.store.event("b" * 40, status, reason)
                with patch.object(deploy.subprocess, "run"):
                    self.recovery.flush()
                self.assertEqual(self.store.get("recovery"), "")
                self.store.block("b" * 40, reason)
                with patch.object(deploy.subprocess, "run"):
                    self.recovery.flush()
                self.assertTrue(self.store.get("recovery"))
                incident = json.loads(self.store.get("recovery"))
                self.assertEqual(incident["reason"], reason)
                self.assertEqual(incident["revision"], "b" * 40)
                self.store.event("c" * 40, "failed", "preflight_failed")
                with patch.object(deploy.subprocess, "run"):
                    self.recovery.flush()
                self.assertEqual(json.loads(self.store.get("recovery")), incident)
                self.store.event(self.revision, "reconciled")
                self.store.set("recovery", "")

    def test_busy_deferral_does_not_create_legacy_hold_or_recovery(self):
        for initialized in ("", "1"):
            with self.subTest(initialized=initialized):
                self.store.set("recoveryInitialized", initialized)
                self.store.event("b" * 40, "deferred", "drain_busy")
                self.recovery.flush()
                self.assertEqual(self.store.get("operatorHold"), "")
                self.assertEqual(self.store.get("recovery"), "")
                self.assertEqual(self.store.status("b" * 40), "deferred")

    def test_unexpected_tick_error_is_private_and_fences_deployment(self):
        host = Mock()
        host.recover_stages.side_effect = ValueError("PRIVATE diagnostic")
        loop = deploy.Deployer(host, self.store, recovery=self.recovery)
        with patch.object(deploy.subprocess, "run"):
            loop.tick()
        self.assertTrue(self.store.get("recovery"))
        incident = json.loads(self.store.get("recovery"))
        self.assertEqual(incident["reason"], "controller_failed")
        self.assertNotIn("PRIVATE", self.store.get("recovery"))
        self.assertNotIn("PRIVATE", (self.root / "feed.json").read_text())
        with patch.object(deploy.subprocess, "run"):
            loop.tick()
        self.assertEqual(json.loads(self.store.get("recovery")), incident)

    def test_reporting_error_never_fences_or_rewrites_candidate_history(self):
        self.store.event(self.revision, "healthy")
        reporter = deploy.GitHubStatuses(self.store, recovery=self.recovery)
        with patch.object(reporter, "token", side_effect=ValueError("PRIVATE token")):
            reporter.flush()
        self.assertEqual(self.store.get("recovery"), "")
        self.assertGreater(reporter.retry_at, time.monotonic())
        self.assertEqual(self.store.status(self.revision), "healthy")

    def test_pending_github_status_reports_global_block_not_infinite_progress(self):
        self.store.event("b" * 40, "received")
        self.store.block("c" * 40, "activation_unknown")
        reporter = deploy.GitHubStatuses(self.store)
        report = reporter.report("b" * 40)
        self.assertEqual(report["status"], "completed")
        self.assertEqual(report["conclusion"], "action_required")
        self.assertEqual(self.store.status("b" * 40), "received")
        self.store.event(self.revision, "reconciled")
        self.assertEqual(reporter.report("b" * 40)["status"], "queued")

    def test_unavailable_public_feed_does_not_prevent_private_recovery(self):
        with patch.object(
            deploy, "atomic_json", side_effect=PermissionError("PRIVATE")
        ):
            reopened = deploy.Store(
                self.root / "records",
                self.root / "feed.json",
                self.revision,
                slack_responder_feed=True,
                publish_feed=False,
            )
            self.addCleanup(reopened.close)
            recovery = deploy.Recovery(reopened)
            recovery.record("controller_failed")
            with patch.object(deploy.subprocess, "run"):
                recovery.flush()
            incident = json.loads(reopened.get("recovery"))
            self.assertEqual(incident["reason"], "controller_failed")
            incident.update(phase="spawned", thread=self.thread)
            reopened.set("recovery", json.dumps(incident))
            recovery.claim(incident["incident"], self.thread)
            self.assertEqual(json.loads(reopened.get("recovery"))["owner"], self.thread)

    def test_reporting_failure_does_not_replace_lifecycle_failure(self):
        host = Mock()
        reporter = deploy.GitHubStatuses(self.store, recovery=self.recovery)
        loop = deploy.Deployer(host, self.store, reporter, self.recovery)
        with (
            patch.object(
                loop,
                "deploy",
                side_effect=lambda: self.store.event(
                    "b" * 40, "failed", "preflight_failed"
                ),
            ),
            patch.object(reporter, "token", side_effect=ValueError("PRIVATE")),
            patch.object(deploy.subprocess, "run"),
        ):
            loop.tick()
        self.assertEqual(
            json.loads(self.store.get("recovery"))["reason"], "preflight_failed"
        )


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

    def tick_after_retry(self):
        retry = json.loads(self.store.get("retry") or "{}")
        with patch.object(
            deploy.time, "time", return_value=max(time.time(), retry.get("after", 0))
        ):
            self.loop.tick()

    def test_failed_preflight_hands_off_and_fences_later_main(self):
        target = self.host.commit("src/console/view.ts", "two")
        self.loop.recovery = deploy.Recovery(self.store)
        run = subprocess.run
        with (
            patch.object(self.host, "prepare", side_effect=ValueError("bad build")),
            patch.object(deploy.subprocess, "run", wraps=subprocess.run) as commands,
        ):
            # Only the recovery systemctl boundary is simulated; fixture Git,
            # SQLite, preparation failure and service state remain real.
            commands.side_effect = lambda args, **kwargs: (
                None if args[0] == "systemctl" else run(args, **kwargs)
            )
            self.loop.tick()
        incident = json.loads(self.store.get("recovery"))
        self.assertEqual(incident["revision"], target)
        self.assertEqual(incident["reason"], "preflight_failed")
        self.host.commit("src/console/view.ts", "three")
        with patch.object(deploy.subprocess, "run"):
            self.loop.tick()
        self.assertEqual(json.loads(self.store.get("recovery")), incident)
        self.assertEqual(self.store.get("active"), self.first)
        self.assertTrue(self.host.healthy(self.first))

    def test_reporting_failure_does_not_prevent_deployment(self):
        target = self.host.commit("src/console/view.ts", "two")
        self.loop.recovery = deploy.Recovery(self.store)
        reporter = deploy.GitHubStatuses(self.store, recovery=self.loop.recovery)
        self.loop.statuses = reporter
        run = subprocess.run
        with (
            patch.object(reporter, "token", side_effect=ValueError("PRIVATE")),
            patch.object(
                deploy.subprocess,
                "run",
                side_effect=lambda args, **kw: (
                    None if args[0] == "systemctl" else run(args, **kw)
                ),
            ),
        ):
            self.loop.tick()
        self.assertEqual(self.store.status(target), "healthy")
        self.assertEqual(self.store.get("intent"), "")
        self.assertEqual(self.store.get("recovery"), "")
        self.assertTrue(self.host.healthy(target))

    def test_idle_runtime_latch_is_detected_without_a_push_and_blames_active(self):
        self.loop.recovery = deploy.Recovery(self.store)
        self.loop.tick()
        (self.host.data / "latch").touch()
        with patch.object(deploy.subprocess, "run"):
            self.loop.tick()
        incident = json.loads(self.store.get("recovery"))
        self.assertEqual(incident["revision"], self.first)
        self.assertEqual(incident["reason"], "lifecycle_failed")
        self.assertEqual(self.store.status(self.first), "blocked")
        self.assertFalse((self.host.data / "drains").exists())

    def test_retry_backoff_survives_restart_then_escalates(self):
        target = self.host.commit("src/console/view.ts", "two")
        self.loop.recovery = deploy.Recovery(self.store)
        with patch.object(self.host, "fetch", side_effect=OSError("PRIVATE")) as fetch:
            with patch.object(deploy.time, "time", return_value=1000):
                self.loop.tick()
                self.assertEqual(fetch.call_count, 1)
                self.assertEqual(self.store.get("recovery"), "")
                loop = deploy.Deployer(
                    self.host, self.store, recovery=self.loop.recovery
                )
                loop.tick()
                self.assertEqual(fetch.call_count, 1)
            for attempt in range(1, 10):
                with (
                    patch.object(deploy.time, "time", return_value=1000 + attempt * 61),
                    patch.object(deploy.subprocess, "run"),
                ):
                    loop.tick()
            self.assertEqual(fetch.call_count, 10)
        self.assertEqual(self.store.get("blocked"), "fetch_failed")
        self.assertEqual(
            json.loads(self.store.get("recovery"))["reason"], "fetch_failed"
        )
        self.assertNotEqual(self.store.status(target), "failed")

    def test_unclean_stop_blocks_activation_and_rollback_without_switch_or_retry(self):
        for failed_stop in (1, 2):
            with self.subTest(failed_stop=failed_stop):
                fixture = DeploymentSafety("runTest")
                fixture.setUp()
                try:
                    target = fixture.host.commit("src/console/view.ts", "bad candidate")
                    service = fixture.host.service
                    stops = 0

                    def checked_service(
                        action,
                        service=service,
                        failed_stop=failed_stop,
                        fixture=fixture,
                    ):
                        nonlocal stops
                        if action != "stop":
                            return service(action)
                        stops += 1
                        if stops != failed_stop:
                            return service(action)
                        pid = str(fixture.host.process.pid)
                        before = {**RUNNING_SERVICE, "MainPID": pid, "ExecMainPID": pid}
                        after = {
                            **STOPPED_SERVICE,
                            "ExecMainPID": pid,
                            "Result": "timeout",
                        }

                        def stop_job(*args, **kwargs):
                            self.assertEqual(
                                args[0], ["systemctl", "stop", "june.service"]
                            )
                            service("stop")
                            return subprocess.CompletedProcess(args[0], 0)

                        with (
                            patch.object(
                                deploy.time, "monotonic_ns", return_value=2_000_000_000
                            ),
                            patch.object(
                                deploy.subprocess,
                                "check_output",
                                side_effect=[
                                    service_output(before),
                                    service_output(after),
                                ],
                            ),
                            patch.object(
                                deploy.subprocess, "run", side_effect=stop_job
                            ),
                        ):
                            return deploy.Host.service(fixture.host, action)

                    with patch.object(
                        fixture.host, "service", side_effect=checked_service
                    ):
                        fixture.loop.tick()
                        self.assertEqual(
                            fixture.store.get("blocked"), "activation_unknown"
                        )
                        self.assertEqual(fixture.store.get("intent"), target)
                        self.assertEqual(fixture.store.get("active"), fixture.first)
                        selected = fixture.first if failed_stop == 1 else target
                        self.assertEqual(
                            fixture.host.current.resolve(),
                            fixture.host.releases / selected,
                        )
                        starts = (
                            [fixture.first]
                            if failed_stop == 1
                            else [fixture.first, target]
                        )
                        self.assertEqual(
                            (fixture.host.data / "starts").read_text().splitlines(),
                            starts,
                        )
                        feed = fixture.store.feed
                        fixture.store.close()
                        fixture.store = deploy.Store(
                            fixture.host.root / "records", feed, fixture.first
                        )
                        fixture.loop = deploy.Deployer(fixture.host, fixture.store)
                        fixture.loop.tick()
                        self.assertEqual(stops, failed_stop)
                        self.assertEqual(
                            (fixture.host.data / "starts").read_text().splitlines(),
                            starts,
                        )
                        self.assertEqual(
                            fixture.store.get("blocked"), "activation_unknown"
                        )
                finally:
                    fixture.tearDown()
                    fixture.doCleanups()

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
        reporter = deploy.GitHubStatuses(self.store, app={"appId": 123})
        self.loop = deploy.Deployer(self.host, self.store, reporter)
        with (
            patch.object(reporter, "token", return_value="fixture-token"),
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
            self.tick_after_retry()
            writes = len(api.writes)
            self.loop.tick()
            self.assertEqual(len(api.writes), writes)
            self.assertEqual(api.runs[41]["conclusion"], "success")
            self.assertEqual(api.runs[41]["head_sha"], target)
            self.assertEqual(api.runs[41]["details_url"], api.runs[41]["html_url"])
            self.assertEqual(api.writes[0][1]["status"], "queued")
            self.assertIn("controller accepted", api.writes[0][1]["output"]["title"])
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
        reporter = deploy.GitHubStatuses(self.store, app={"appId": 123})
        self.loop = deploy.Deployer(self.host, self.store, reporter)
        with (
            patch.object(reporter, "token", return_value="fixture-token"),
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
        reporter = deploy.GitHubStatuses(self.store, app={"appId": 123})
        self.loop = deploy.Deployer(self.host, self.store, reporter)
        with (
            patch.object(reporter, "token", return_value="fixture-token"),
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
            newer = self.host.commit("src/console/view.ts", "queued during low disk")
            self.tick_after_retry()
        self.assertEqual(self.store.status(target), "superseded")
        self.assertEqual(self.store.status(newer), "deferred")
        self.assertEqual(self.store.get("active"), self.first)
        self.assertFalse(self.store.get("intent"))
        self.assertFalse((self.host.releases / target).exists())
        self.assertFalse((self.host.data / "drains").exists())
        self.assertEqual(
            (self.host.data / "starts").read_text().splitlines(), [self.first]
        )
        events = json.loads(self.store.feed.read_text())["events"]
        self.assertEqual(
            [event["status"] for event in events],
            ["received", "deferred", "received", "superseded", "deferred"],
        )
        self.assertEqual(events[1]["reason"], "insufficient_disk")

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
            self.tick_after_retry()
        self.assertEqual(self.store.status(newer), "deferred")
        self.assertFalse((self.host.releases / newer).exists())
        self.assertEqual(list(self.host.stage_root.glob("stage-*")), [])
        self.assertFalse((self.host.data / "drains").exists())
        with patch.object(
            deploy.shutil, "disk_usage", return_value=disk._replace(free=4 * 1024**3)
        ):
            self.tick_after_retry()
        self.assertEqual(self.store.get("active"), newer)
        self.loop.tick()
        self.assertEqual(self.store.get("active"), newer)
        self.assertEqual(
            (self.host.data / "starts").read_text().splitlines(),
            [self.first, newer],
        )
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

    def test_first_healthy_feed_includes_exact_candidate_title_before_late_metadata(
        self,
    ):
        self.store.repository_metadata_feed = True
        self.host.commit("src/console/view.ts", "two")
        self.host.git(
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "--amend",
            "-qm",
            "fix(fixture): include deploy title",
        )
        target = self.host.git("rev-parse", "HEAD")

        def advance_main():
            for index in range(12):
                self.host.commit("src/console/view.ts", f"newer {index}")

        self.host.after_prepare = advance_main
        healthy_feeds = []
        publish = self.store.publish

        def capture_feed():
            publish()
            feed = json.loads(self.store.feed.read_text())
            if feed["events"] and feed["events"][-1]["status"] == "healthy":
                healthy_feeds.append(feed)

        with patch.object(self.store, "publish", capture_feed):
            self.loop.tick()
        self.assertEqual(self.store.status(target), "healthy")
        snapshot = healthy_feeds[0].get("repositorySnapshot", {})
        commits = {item["revision"]: item for item in snapshot.get("commits", [])}
        self.assertIn(target, commits, "the first healthy event must carry its title")
        self.assertEqual(commits[target]["title"], "fix(fixture): include deploy title")
        self.assertIn(self.first, commits)
        self.assertEqual(snapshot["revision"], self.host.fetch())
        self.assertNotEqual(snapshot["revision"], target)
        self.assertEqual(len(commits), 10)

    def test_missing_optional_commit_metadata_does_not_block_deployment(self):
        self.store.repository_metadata_feed = True
        target = self.host.commit("src/console/view.ts", "two")
        with patch.object(
            self.host,
            "repository_snapshot",
            side_effect=RuntimeError("SECRET Git error"),
        ):
            self.loop.tick()
        feed = json.loads(self.store.feed.read_text())
        self.assertEqual(feed["events"][-1]["status"], "healthy")
        self.assertEqual(feed["lastHealthyRevision"], target)
        self.assertFalse(feed["blocked"])
        self.assertNotIn("repositorySnapshot", feed)
        self.assertNotIn("SECRET", self.store.feed.read_text())

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

    def test_prepared_candidates_progress_during_continuous_forward_arrivals(self):
        target = self.host.commit("src/console/view.ts", "two")
        queued = [target]
        started = [self.first]
        drain = self.host.drain
        for attempt in range(3):
            target = queued[-1]
            arrivals = []
            self.host.after_prepare = lambda arrivals=arrivals, attempt=attempt: (
                arrivals.append(
                    self.host.commit("src/console/view.ts", f"prepared {attempt}")
                )
            )

            def drain_with_arrival(previous, arrivals=arrivals, attempt=attempt):
                result = drain(previous)
                arrivals.append(
                    self.host.commit("src/console/view.ts", f"drained {attempt}")
                )
                return result

            with patch.object(self.host, "drain", side_effect=drain_with_arrival):
                self.loop.tick()
            self.assertEqual(self.store.get("active"), target)
            self.assertTrue(self.host.running(target))
            self.assertEqual(self.store.status(target), "healthy")
            self.assertNotIn(
                "superseded",
                [
                    event["status"]
                    for event in json.loads(self.store.feed.read_text())["events"]
                    if event["revision"] == target
                ],
            )
            self.assertEqual(self.store.status(arrivals[0]), "received")
            self.assertEqual(self.store.status(arrivals[1]), "received")
            self.assertFalse(self.store.get("intent"))
            started.append(target)
            queued.extend(arrivals)

        # Finish the newest head, not every historical restart in the backlog.
        target = queued[-1]
        self.loop.tick()
        self.assertEqual(self.store.get("active"), target)
        started.append(target)
        for skipped in queued:
            if skipped not in started:
                self.assertEqual(self.store.status(skipped), "superseded")
        self.loop.tick()
        self.host.git("reset", "--hard", started[1])
        self.loop.tick()
        self.assertEqual(self.store.get("active"), target)
        self.assertEqual(self.store.get("blocked"), "non_fast_forward")
        self.assertEqual((self.host.data / "starts").read_text().splitlines(), started)

    def test_divergence_after_preparation_blocks_candidate_without_drain(self):
        target = self.host.commit("src/console/view.ts", "candidate")

        def diverge():
            self.host.git("reset", "--hard", self.first)
            self.host.commit("src/console/view.ts", "divergent head")

        self.host.after_prepare = diverge
        self.loop.tick()
        self.assertEqual(self.store.get("blocked"), "non_fast_forward")
        self.assertEqual(self.store.status(target), "blocked")
        self.assertTrue(self.host.running(self.first))
        self.assertFalse(self.store.get("intent"))
        self.assertFalse((self.host.data / "drains").exists())
        self.assertEqual(
            (self.host.data / "starts").read_text().splitlines(), [self.first]
        )
        events = json.loads(self.store.feed.read_text())["events"]
        candidate = [event for event in events if event["revision"] == target]
        self.assertEqual(candidate[-1]["reason"], "non_fast_forward")
        self.assertNotIn("superseded", [event["status"] for event in candidate])

    def test_rewind_after_drain_blocks_candidate_and_resumes_current(self):
        target = self.host.commit("src/console/view.ts", "two")
        self.host.after_prepare = lambda: self.host.commit(
            "src/console/view.ts", "newer head"
        )
        drain = self.host.drain

        def rewind_after_drain(previous):
            result = drain(previous)
            self.host.git("reset", "--hard", target)
            return result

        with patch.object(self.host, "drain", side_effect=rewind_after_drain):
            self.loop.tick()
        self.assertEqual(self.store.get("blocked"), "non_fast_forward")
        self.assertEqual(self.store.status(target), "blocked")
        self.assertEqual(self.store.get("active"), self.first)
        self.assertTrue(self.host.running(self.first))
        self.assertFalse(self.store.get("intent"))
        self.assertEqual(
            (self.host.data / "starts").read_text().splitlines(), [self.first]
        )
        self.assertEqual(
            (self.host.data / "resumes").read_text().splitlines(), [self.first]
        )

    def test_already_contained_pending_candidate_never_downgrades_running_release(self):
        target = self.host.commit("src/console/view.ts", "two")
        self.store.event(target, "received")
        self.store.event(target, "deferred", "insufficient_disk")
        running = self.host.commit("src/console/view.ts", "three")
        self.host.prepare(running)
        self.host.service("stop")
        self.host.switch(running)
        self.host.service("start")
        self.loop.reconcile(running)
        received = self.host.commit("src/console/view.ts", "legacy received")
        self.store.event(received, "received")
        preparing = self.host.commit("src/console/view.ts", "legacy preparing")
        self.store.event(preparing, "received")
        self.store.event(preparing, "preparing")
        self.store.set("observed", preparing)
        unconfirmed = self.host.commit(
            "src/console/view.ts", "legacy partial observation"
        )
        self.store.event(unconfirmed, "received")
        newest = self.host.commit("src/console/view.ts", "new head")
        self.loop.tick()
        self.assertFalse(self.store.get("blocked"))
        self.assertEqual(self.store.status(target), "superseded")
        self.assertTrue(self.host.running(newest))
        self.assertEqual(self.store.get("active"), newest)
        self.assertEqual(self.store.status(unconfirmed), "superseded")
        for candidate in (received, preparing):
            self.assertEqual(self.store.status(candidate), "superseded")
        self.assertEqual(
            (self.host.data / "starts").read_text().splitlines(),
            [self.first, running, newest],
        )

    def test_supersession_publication_failure_never_falls_back_to_older_work(self):
        pending = []
        for index in range(3):
            pending.append(self.host.commit("src/console/view.ts", f"pending {index}"))
            self.loop.observe()
        publish = self.store.publish

        def fail_after_first_supersession():
            if self.store.status(pending[0]) == "superseded":
                raise OSError("fixture feed publication failure")
            publish()

        with (
            patch.object(
                self.store, "publish", side_effect=fail_after_first_supersession
            ),
            self.assertRaises(OSError),
        ):
            self.loop.tick()
        self.assertEqual(self.store.status(pending[-1]), "received")
        self.assertFalse((self.host.data / "drains").exists())
        feed = self.store.feed
        self.store.close()
        self.store = deploy.Store(self.host.root / "records", feed, self.first)
        self.loop = deploy.Deployer(self.host, self.store)
        self.loop.tick()
        self.loop.tick()
        self.assertEqual(self.store.status(pending[1]), "superseded")
        self.assertEqual(self.store.status(pending[-1]), "healthy")
        self.assertEqual(
            (self.host.data / "starts").read_text().splitlines(),
            [self.first, pending[-1]],
        )

    def test_admission_survives_observer_crash_without_admitting_intermediates(self):
        skipped = self.host.commit("src/console/view.ts", "unobserved intermediate")
        picked = self.host.commit("src/console/view.ts", "picked head")
        save = self.store.set

        def interrupt_observed(key, value):
            if key == "observed":
                raise OSError("fixture observer crash")
            save(key, value)

        with patch.object(self.store, "set", side_effect=interrupt_observed):
            self.loop.tick()
        self.assertTrue(self.host.running(self.first))
        self.assertEqual(self.store.status(skipped), "superseded")
        feed = self.store.feed
        self.store.close()
        self.store = deploy.Store(self.host.root / "records", feed, self.first)
        self.loop = deploy.Deployer(self.host, self.store)
        newest = self.host.commit("src/console/view.ts", "newer after restart")
        self.tick_after_retry()
        self.assertEqual(self.store.get("active"), newest)
        self.assertEqual(self.store.status(picked), "superseded")
        self.loop.tick()
        self.assertEqual(self.store.get("active"), newest)
        self.assertEqual(self.store.status(skipped), "superseded")
        self.assertEqual(
            (self.host.data / "starts").read_text().splitlines(),
            [self.first, newest],
        )

        for boundary in ("cursor", "receipt"):
            running = self.store.get("active")
            admitted = self.host.commit("src/console/view.ts", f"admitted {boundary}")
            save = self.store.set

            def interrupt(key, value, boundary=boundary, save=save):
                if key == "observed" and boundary == "cursor":
                    raise OSError("fixture before cursor")
                save(key, value)
                if key == "queue" and boundary == "receipt":
                    raise OSError("fixture after admission, before receipt")

            with patch.object(self.store, "set", side_effect=interrupt):
                self.loop.tick()
            self.store.close()
            self.store = deploy.Store(self.host.root / "records", feed, self.first)
            self.loop = deploy.Deployer(self.host, self.store)
            starts = (self.host.data / "starts").read_text()
            drains = (self.host.data / "drains").read_text()
            self.host.git("reset", "--hard", running)
            for change in ("rewind", "diverge"):
                if change == "diverge":
                    self.loop.reconcile(running)
                    self.host.commit("src/console/view.ts", f"diverge {boundary}")
                self.tick_after_retry()
                self.assertEqual(self.store.get("blocked"), "non_fast_forward")
                self.assertTrue(self.host.running(running))
                self.assertEqual((self.host.data / "starts").read_text(), starts)
                self.assertEqual((self.host.data / "drains").read_text(), drains)
                self.assertFalse(self.store.get("intent"))
            # Restoring the admitted history and explicitly reconciling is safe.
            self.host.git("reset", "--hard", admitted)
            self.loop.reconcile(running)
            self.loop.tick()
            self.assertTrue(self.host.running(admitted))

    def test_busy_workers_and_preflight_failure_preserve_current_and_changed_contract_can_forward(
        self,
    ):
        target = self.host.commit("src/console/view.ts", "two")
        newer = []
        self.host.after_prepare = lambda: newer.append(
            self.host.commit("src/console/view.ts", "newer while busy")
        )
        (self.host.data / "busy").touch()
        self.loop.tick()
        self.assertEqual(self.store.get("active"), self.first)
        self.assertEqual(self.store.status(target), "deferred")
        third = self.host.commit("src/console/view.ts", "third while busy")
        self.loop.tick()
        feed = self.store.feed
        self.store.close()
        self.store = deploy.Store(self.host.root / "records", feed, self.first)
        self.loop = deploy.Deployer(self.host, self.store)
        (self.host.data / "busy").unlink()
        self.tick_after_retry()
        self.assertEqual(self.store.get("active"), third)
        self.assertEqual(self.store.status(target), "superseded")
        self.assertEqual(self.store.status(newer[0]), "superseded")
        self.assertEqual(
            (self.host.data / "starts").read_text().splitlines(),
            [self.first, third],
        )
        bad = self.host.commit("src/broken", "SECRET_FROM_BUILD")
        self.loop.tick()
        self.loop.tick()
        self.assertEqual(self.store.get("active"), third)
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
        self.tick_after_retry()
        self.assertEqual(
            (self.host.data / "starts").read_text().splitlines(),
            [self.first, target, self.first],
        )
        forward_bad = self.host.commit(
            "src/runtime/registry.ts", "forward-only new journal"
        )
        self.tick_after_retry()
        self.assertEqual(self.store.status(forward_bad), "blocked")
        self.assertEqual(self.store.get("blocked"), "unsafe_rollback")
        self.assertIsNone(self.host.process)


class WarmStandbySafety(unittest.TestCase):
    # Real disposable Git/releases/SQLite/HTTP app. Only the second-slot manager
    # is simulated here; TS standby tests exercise the real process/kernel lock.
    setUp = DeploymentSafety.setUp
    tearDown = DeploymentSafety.tearDown
    tick_after_retry = DeploymentSafety.tick_after_retry

    def enable_slots(self):
        host = self.host
        host.config["blueGreen"] = {"intakeOrigin": "http://127.0.0.1:3083"}
        host.origin = lambda commit: host.config["origin"]
        self.trace = []

        def prepare(commit, previous):
            self.assertTrue(host.healthy(previous))
            self.assertEqual(self.store.get("intent"), commit)
            self.trace.append("standby")

        def intake(commit, *, paused):
            self.trace.append("pause" if paused else "forward")
            if not paused:
                self.assertTrue(host.healthy(commit))

        def activate(commit):
            self.assertEqual(self.store.get("intent"), commit)
            self.assertIsNone(host.process)
            self.trace.append("activate")
            host.service("start")

        host.prepare_standby = prepare
        host.intake = intake
        host.activate = activate
        host.standby = lambda commit: True
        host.wait_standby = lambda commit: None

    def test_activating_receipt_cannot_leave_a_resumable_checkpoint(self):
        self.enable_slots()
        target = self.host.commit("src/console/view.ts", "receipt interruption")
        event = self.store.event

        def crash(commit, status, *args, **kwargs):
            event(commit, status, *args, **kwargs)
            if status == "activating":
                raise KeyboardInterrupt()

        with (
            patch.object(self.store, "event", side_effect=crash),
            self.assertRaises(KeyboardInterrupt),
        ):
            self.loop.tick()
        # A receipt must not be able to outlive cleared resumable intent and
        # silently disappear from pending(). Unknown stop effects stay blocked.
        self.assertEqual(
            json.loads(self.store.get("cutover"))["phase"], "stop_requested"
        )
        deploy.Deployer(self.host, self.store).tick()
        self.assertTrue(self.store.get("blocked"))
        self.assertEqual(self.store.get("intent"), target)
        self.assertTrue(self.host.healthy(self.first))

    def test_restart_recovers_only_acknowledged_pre_stop_checkpoints(self):
        for phase in (
            "standby_ready",
            "intake_paused",
            "drain_settled",
            "pausing",
            "draining",
            "stop_requested",
            "activating",
        ):
            with self.subTest(phase=phase):
                self.enable_slots()
                target = self.host.commit("src/console/view.ts", phase)
                self.store.set("blocked", "")
                self.store.set("intent", "")
                self.store.set("cutover", "")
                self.store.set("retry", "")
                checkpoint = self.store.checkpoint

                def crash(commit, stage, checkpoint=checkpoint, phase=phase, **kwargs):
                    checkpoint(commit, stage, **kwargs)
                    if stage == phase:
                        raise KeyboardInterrupt()

                with (
                    patch.object(self.store, "checkpoint", side_effect=crash),
                    self.assertRaises(KeyboardInterrupt),
                ):
                    deploy.Deployer(self.host, self.store).tick()
                with (
                    patch.object(self.host, "service") as service,
                    patch.object(self.host, "resume", return_value=True) as resume,
                ):
                    deploy.Deployer(self.host, self.store).tick()
                safe = phase in ("standby_ready", "intake_paused", "drain_settled")
                self.assertEqual(resume.call_count, int(safe))
                service.assert_not_called()
                self.assertEqual(bool(self.store.get("blocked")), not safe)
                self.assertEqual(self.store.get("intent"), "" if safe else target)
                if phase == "activating":
                    # The fixture was stopped before this crash; restore only
                    # disposable fixture state for teardown, never production.
                    self.host.switch(self.first)
                    self.host.service("start")
                    self.assertTrue(self.host.healthy(self.first))

    def test_pre_stop_recovery_rejects_changed_identity_and_ambiguous_resume(self):
        self.enable_slots()
        target = self.host.commit("src/console/view.ts", "two")
        for changed in (True, False):
            self.store.set("blocked", "")
            self.store.set("cutover", "")
            self.store.checkpoint(
                target, "drain_settled", identity=self.host.runtime_identity(self.first)
            )
            with (
                patch.object(
                    self.host,
                    "runtime_identity",
                    return_value={"fixturePid": -1}
                    if changed
                    else self.host.runtime_identity(self.first),
                ),
                patch.object(self.host, "resume", side_effect=TimeoutError()) as resume,
            ):
                deploy.Deployer(self.host, self.store).tick()
                deploy.Deployer(self.host, self.store).tick()
            self.assertEqual(resume.call_count, 0 if changed else 1)
            self.assertTrue(self.store.get("blocked"))

    def test_fetch_after_build_is_not_a_failed_candidate(self):
        self.enable_slots()
        target = self.host.commit("src/console/view.ts", "two")
        with patch.object(self.host, "fetch", side_effect=[target, OSError("PRIVATE")]):
            self.loop.tick()
        self.assertEqual(self.store.status(target), "preparing")
        self.assertFalse(self.store.get("blocked"))
        self.assertFalse(self.store.get("intent"))
        self.assertEqual(self.trace, [])

    def test_failed_candidate_http_409_never_authorizes_stop(self):
        self.enable_slots()
        target = self.host.commit("src/console/view.ts", "bad health")
        activate = self.host.activate

        def busy_candidate(commit):
            activate(commit)
            (self.host.data / "busy").touch()

        with patch.object(self.host, "activate", side_effect=busy_candidate):
            self.loop.tick()
        self.assertEqual(self.store.get("blocked"), "candidate_not_drained")
        self.assertTrue(self.host.running(target))
        self.assertEqual(
            (self.host.data / "starts").read_text().splitlines(), [self.first, target]
        )

    def test_failed_standby_keeps_old_process_and_never_pauses_intake(self):
        self.enable_slots()
        pid = self.host.process.pid
        target = self.host.commit("src/console/view.ts", "two")
        with patch.object(
            self.host, "prepare_standby", side_effect=ValueError("bad startup")
        ):
            self.loop.tick()
        self.assertEqual(self.host.process.pid, pid)
        self.assertTrue(self.host.healthy(self.first))
        self.assertEqual(self.trace, [])
        self.assertEqual(self.store.get("blocked"), "standby_unavailable")
        # Reopen never retries an unknown launch or stops the old runtime.
        deploy.Deployer(self.host, self.store).tick()
        self.assertEqual(self.host.process.pid, pid)
        self.assertEqual(self.store.get("intent"), target)

    def test_busy_drain_resumes_old_then_cutover_forwards_only_after_health(self):
        self.enable_slots()
        self.loop.recovery = deploy.Recovery(self.store)
        target = self.host.commit("src/console/view.ts", "two")
        pid = self.host.process.pid
        notice = Mock()
        self.host.notify_swap = notice
        (self.host.data / "busy").touch()
        self.loop.tick()
        notice.assert_not_called()
        self.assertEqual(self.trace, ["standby", "pause", "forward"])
        self.assertEqual(self.host.process.pid, pid)
        self.assertEqual(self.store.get("intent"), "")
        self.assertEqual(self.store.get("recovery"), "")
        self.assertEqual(self.store.status(target), "deferred")
        (self.host.data / "busy").unlink()
        self.trace.clear()

        def notify(previous, commit, attempt):
            self.assertEqual((previous, commit), (self.first, target))
            self.assertIsInstance(attempt, int)
            self.assertEqual(self.host.process.pid, pid)
            self.assertEqual(
                json.loads(self.store.get("cutover"))["phase"], "stop_requested"
            )
            self.assertEqual(self.trace, ["standby", "pause"])

        notice.side_effect = notify
        self.tick_after_retry()
        notice.assert_called_once()
        self.assertEqual(self.trace, ["standby", "pause", "activate", "forward"])
        self.assertTrue(self.host.healthy(target))
        self.assertEqual(self.store.get("active"), target)
        self.assertEqual(
            (self.host.data / "starts").read_text().splitlines(), [self.first, target]
        )

    def test_uncertain_drain_blocks_instead_of_retrying_as_busy(self):
        self.enable_slots()
        pid = self.host.process.pid
        request = self.host.request
        for index, response in enumerate(
            (
                {"revision": "b" * 40, "drained": False},
                {"revision": self.first, "drained": 0},
                {"error": "drain_unsupported_configuration"},
                TimeoutError("private transport details"),
            )
        ):
            with self.subTest(response=response):
                target = self.host.commit("src/console/view.ts", f"candidate {index}")

                def uncertain(path, *args, response=response, **kwargs):
                    if path == "/operator/deployment/drain?swapNotice=1" and args == (
                        "POST",
                    ):
                        if isinstance(response, Exception):
                            raise response
                        return response
                    return request(path, *args, **kwargs)

                with patch.object(self.host, "request", side_effect=uncertain):
                    self.loop.tick()
                self.assertEqual(self.store.status(target), "blocked")
                self.assertEqual(self.store.get("blocked"), "cutover_interrupted")
                self.assertEqual(self.store.get("intent"), target)
                self.assertEqual(self.host.process.pid, pid)
                self.assertTrue(self.host.healthy(self.first))
                self.loop.reconcile(self.first)

    def test_release_hashing_finishes_before_intake_pauses(self):
        self.enable_slots()
        target = self.host.commit("src/console/view.ts", "two")
        digest = deploy.tree_digest
        paused_reads = []

        def measure(root):
            if "pause" in self.trace and "forward" not in self.trace:
                paused_reads.append(root)
            return digest(root)

        with patch.object(deploy, "tree_digest", side_effect=measure):
            self.loop.tick()
        self.assertEqual(self.store.status(target), "healthy")
        self.assertEqual(self.trace, ["standby", "pause", "activate", "forward"])
        self.assertEqual(paused_reads, [])

    def test_binding_drift_during_drain_resumes_without_activation(self):
        self.enable_slots()
        target = self.host.commit("src/console/view.ts", "two")
        pid = self.host.process.pid
        drain = self.host.drain

        def changed_binding(commit):
            drained = drain(commit)
            self.host.binding = lambda: "b" * 64
            return drained

        with patch.object(self.host, "drain", side_effect=changed_binding):
            self.loop.tick()
        self.assertEqual(self.store.status(target), "blocked")
        self.assertEqual(self.store.get("blocked"), "binding_changed")
        self.assertEqual(self.trace, ["standby", "pause", "forward"])
        self.assertEqual(self.host.process.pid, pid)
        self.assertTrue(self.host.healthy(self.first))
        self.assertEqual(self.store.get("intent"), "")

    def test_retry_revalidates_retained_release_before_pausing(self):
        self.enable_slots()
        target = self.host.commit("src/console/view.ts", "two")
        (self.host.data / "busy").touch()
        self.loop.tick()
        self.assertEqual(self.store.status(target), "deferred")
        (self.host.data / "busy").unlink()
        (self.host.releases / target / "src/console/view.ts").write_text("changed")
        self.trace.clear()
        pid = self.host.process.pid
        self.tick_after_retry()
        self.assertEqual(self.store.status(target), "failed")
        self.assertEqual(self.trace, [])
        self.assertEqual(self.host.process.pid, pid)
        self.assertTrue(self.host.healthy(self.first))

    def test_slot_environment_change_blocks_before_drain(self):
        self.enable_slots()
        with (
            patch.object(Path, "read_bytes", return_value=b"unchanged config/runtime"),
            patch.object(
                deploy.subprocess, "check_output", return_value=b"unchanged units"
            ),
            patch.object(
                deploy, "private_file", return_value="RIVETKIT_STORAGE_PATH=/old"
            ) as environment,
        ):
            before = deploy.Host.binding(self.host)
            environment.return_value = "RIVETKIT_STORAGE_PATH=/new"
            after = deploy.Host.binding(self.host)
        self.assertNotEqual(before, after)
        # Bind the already-running fixture to 'before', then prepare a candidate
        # under the changed environment. No source-contract change is necessary.
        marker = self.host.releases / self.first / ".june-release.json"
        saved = json.loads(marker.read_text())
        saved["binding"] = before
        marker.write_text(json.dumps(saved))
        self.host.binding = lambda: after
        target = self.host.commit("src/console/view.ts", "presentation only")
        pid = self.host.process.pid
        self.loop.tick()
        self.assertEqual(self.store.status(target), "blocked")
        self.assertEqual(self.store.get("blocked"), "binding_changed")
        self.assertEqual(self.trace, [])
        self.assertEqual(self.host.process.pid, pid)
        self.assertTrue(self.host.healthy(self.first))

    def test_unknown_stop_or_activation_never_retries_or_forwards_candidate(self):
        for boundary in ("service", "activate"):
            with self.subTest(boundary=boundary):
                self.enable_slots()
                target = self.host.commit("src/console/view.ts", boundary)
                self.store.set("blocked", "")
                self.store.clear_cutover()
                self.loop = deploy.Deployer(self.host, self.store)
                with patch.object(
                    self.host, boundary, side_effect=ValueError("uncertain")
                ):
                    self.loop.tick()
                self.assertEqual(self.store.get("blocked"), "activation_unknown")
                self.assertEqual(self.trace, ["standby", "pause"])
                before = (self.host.data / "starts").read_text()
                deploy.Deployer(self.host, self.store).tick()
                self.assertEqual((self.host.data / "starts").read_text(), before)
                self.assertEqual(self.store.get("intent"), target)

    def test_missing_cgroup_evidence_blocks_activation_before_http(self):
        host = object.__new__(deploy.Host)
        host.config = {"blueGreen": {"intakeOrigin": "http://127.0.0.1:3083"}}
        host.slot = lambda commit: "green"
        for empty in (False, True):
            with (
                self.subTest(empty=empty),
                patch.object(host, "unit_empty", return_value=empty),
                patch.object(host, "standby", return_value=True),
                patch.object(
                    host,
                    "request",
                    return_value={"revision": self.first, "activated": True},
                ) as request,
            ):
                if empty:
                    host.activate(self.first)
                    self.assertEqual(
                        request.call_args.kwargs["data"], {"revision": self.first}
                    )
                else:
                    with self.assertRaisesRegex(ValueError, "runtime_not_exclusive"):
                        host.activate(self.first)
                    request.assert_not_called()


if __name__ == "__main__":
    unittest.main()
