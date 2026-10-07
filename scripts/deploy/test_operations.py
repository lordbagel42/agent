"""Operations producers: disposable SQLite, fake collectors and launchers only."""

import importlib.util
import io
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import Mock, patch


def load(name):
    spec = importlib.util.spec_from_file_location(
        name, Path(__file__).with_name(f"{name}.py")
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


deploy = load("deploy")
dispatch = load("debugshare")
IDENTITY = "12345678-1234-4234-8234-123456789abc"
THREAD = f"T-{IDENTITY}"
REVISION = "a" * 40
PRIVATE = "private_sentinel_must_never_be_metadata"


class Operations(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        token = self.root / "ingest-token"
        token.write_text("a" * 40)
        token.chmod(0o600)
        self.config = {
            "origin": "https://debug.example.test",
            "tokenFile": str(token),
            "database": str(self.root / "operations.sqlite"),
        }

    def reporter(self):
        self.assertTrue(
            Path(__file__).with_name("operations.py").is_file(),
            "durable source reporter is missing",
        )
        self.ops = load("operations")
        reporter = self.ops.Reporter(self.config)
        self.addCleanup(reporter.close)
        return reporter

    def events(self, source=None):
        with closing(sqlite3.connect(self.config["database"])) as db:
            events = [
                json.loads(row[0])
                for row in db.execute(
                    "SELECT payload FROM operation_journal ORDER BY position"
                )
            ]
        return [
            event for event in events if source is None or event["source"] == source
        ]

    def store(self, reporter):
        store = deploy.Store(
            self.root / "records", self.root / "feed.json", REVISION, reporter=reporter
        )
        self.addCleanup(store.close)
        return store

    def test_destination_is_bound_and_permanent_rejection_is_retained(self):
        reporter = self.reporter()
        reporter.recovery(
            {
                "incident": 17,
                "revision": REVISION,
                "reason": "health_failed",
                "phase": "pending",
            }
        )
        with self.assertRaises(ValueError):
            self.ops.Reporter({**self.config, "origin": "https://other.example.test"})
        rejected = self.ops.urllib.error.HTTPError(
            "https://debug.example.test", 403, PRIVATE, {}, None
        )
        with patch.object(
            self.ops.urllib.request.OpenerDirector, "open", side_effect=rejected
        ) as transport:
            reporter.upload_pending()
            with patch.object(self.ops.time, "time", return_value=9_000_000_000):
                reporter.upload_pending()
            self.assertEqual(transport.call_count, 1)
        with closing(sqlite3.connect(self.config["database"])) as db:
            self.assertEqual(
                db.execute("SELECT state FROM operation_journal").fetchone()[0],
                "rejected",
            )
        self.assertEqual(len(self.events()), 1)

    def test_offline_retry_restart_reuses_bytes_and_conflict_never_overwrites(self):
        reporter = self.reporter()
        reporter.recovery(
            {
                "incident": 17,
                "revision": REVISION,
                "reason": "health_failed",
                "phase": "pending",
            }
        )
        calls = []

        def offline(request, timeout):
            self.assertEqual(timeout, 5)
            calls.append(request.data)
            raise OSError(PRIVATE)

        with patch.object(
            self.ops.urllib.request.OpenerDirector, "open", side_effect=offline
        ):
            reporter.upload_pending()
        original = self.events()[0]
        reporter.close()
        reopened = self.reporter()

        def accepted(request, timeout):
            self.assertEqual(request.get_method(), "PUT")
            self.assertTrue(
                request.full_url.endswith("/api/ingest/operations/" + original["id"])
            )
            self.assertEqual(request.get_header("Authorization"), "Bearer " + "a" * 40)
            calls.append(request.data)
            response = io.BytesIO(
                json.dumps({"id": original["id"], "saved": True}).encode()
            )
            response.status = 201
            return response

        with (
            patch.object(self.ops.time, "time", return_value=9_000_000_000),
            patch.object(
                self.ops.urllib.request.OpenerDirector, "open", side_effect=accepted
            ),
        ):
            reopened.upload_pending()
            reopened.upload_pending()
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0], calls[1])
        self.assertEqual(self.events(), [original])
        reopened.recovery(
            {
                "incident": 18,
                "revision": REVISION,
                "reason": "health_failed",
                "phase": "pending",
            }
        )
        conflict = self.ops.urllib.error.HTTPError(
            "https://debug.example.test", 409, PRIVATE, {}, None
        )
        with patch.object(
            self.ops.urllib.request.OpenerDirector, "open", side_effect=conflict
        ) as transport:
            reopened.upload_pending()
            reopened.upload_pending()
            self.assertEqual(transport.call_count, 1)
        with closing(sqlite3.connect(self.config["database"])) as db:
            self.assertEqual(
                [
                    row[0]
                    for row in db.execute(
                        "SELECT state FROM operation_journal ORDER BY position"
                    )
                ],
                ["saved", "conflict"],
            )

    def test_gap_backfill_does_not_replace_current_state_with_an_old_failure(self):
        reporter = self.reporter()
        store = self.store(reporter)
        with patch.object(reporter, "deployment", side_effect=OSError(PRIVATE)):
            store.event(REVISION, "failed", "health_failed")
        store.event(REVISION, "healthy")
        reporter.backfill(store)
        events = self.events("deployment")
        self.assertTrue(any(event["failure"] for event in events))
        self.assertEqual(events[-1]["status"], "healthy")
        before = self.events()
        reporter.backfill(store)
        self.assertEqual(self.events(), before)
        incident = {
            "incident": 81,
            "revision": REVISION,
            "reason": "health_failed",
            "thread": THREAD,
            "owner": THREAD,
            "phase": "spawned",
        }
        reporter.recovery(incident)
        reporter.recovery({**incident, "owner": None})  # delayed CAS observer
        self.assertEqual(self.events("recovery")[-1]["status"], "claimed")

    def test_malformed_ack_stays_pending_and_redirect_is_denied(self):
        reporter = self.reporter()
        reporter.recovery(
            {
                "incident": 17,
                "revision": REVISION,
                "reason": "health_failed",
                "phase": "pending",
            }
        )
        event = self.events()[0]

        for clock, body in (
            (100, json.dumps({"id": event["id"], "saved": 1}).encode()),
            (200, b" " * 4097),
        ):
            response = io.BytesIO(body)
            response.status = 200
            with (
                patch.object(self.ops.time, "time", return_value=clock),
                patch.object(
                    self.ops.urllib.request.OpenerDirector,
                    "open",
                    return_value=response,
                ),
            ):
                reporter.upload_pending()
        with closing(sqlite3.connect(self.config["database"])) as db:
            self.assertEqual(
                db.execute("SELECT state FROM operation_journal").fetchone()[0],
                "pending",
            )
        with self.assertRaises(ValueError):
            self.ops.NoRedirect().redirect_request(
                None, None, 302, "", {}, "https://untrusted.example"
            )
        with (
            patch.object(self.ops.time, "time", return_value=9_000_000_000),
            patch.object(
                self.ops.urllib.request.OpenerDirector,
                "open",
                side_effect=lambda *_args, **_kwargs: (
                    self.ops.NoRedirect().redirect_request(
                        None, None, 302, "", {}, "https://untrusted.example"
                    )
                ),
            ) as transport,
        ):
            reporter.upload_pending()
            with patch.object(self.ops.time, "time", return_value=9_000_000_600):
                reporter.upload_pending()
            self.assertEqual(transport.call_count, 1)
        with closing(sqlite3.connect(self.config["database"])) as db:
            self.assertEqual(
                db.execute("SELECT state FROM operation_journal").fetchone()[0],
                "rejected",
            )

    def test_readiness_retries_and_completed_results_with_broken_reporting_logs(self):
        reporter = self.reporter()
        store = self.store(reporter)
        path = self.root / f"{IDENTITY}.task.json"
        path.write_text(
            json.dumps(
                {
                    "id": IDENTITY,
                    "kind": "amp-task",
                    "title": PRIVATE,
                    "prompt": PRIVATE,
                    "ownerRequest": PRIVATE,
                    "revision": PRIVATE,
                }
            )
        )
        path.chmod(0o600)
        with patch.object(dispatch.time, "time", return_value=100):
            dispatch.dispatch(
                self.root,
                path,
                [sys.executable, "-c", "raise SystemExit(1)"],
                reporter=reporter,
            )
        receipt_path = self.root / f"{IDENTITY}.receipt.json"
        self.assertEqual(
            json.loads(receipt_path.read_text()),
            {"id": IDENTITY, "status": "queued", "retryAt": 130000},
        )
        self.assertEqual(self.events("amp-task")[-1]["reason"], "readiness_unavailable")
        self.assertEqual(self.events("amp-task")[-1]["attempt"], 1)
        with patch.object(dispatch.time, "time", return_value=129):
            dispatch.dispatch(self.root, path, ["/must/not/launch"], reporter=reporter)
        transport = (
            "import sys,json; print(sys.argv[1],flush=True); json.load(sys.stdin); "
            + f"print(json.dumps({{'type':'system','subtype':'init','session_id':{THREAD!r}}})); print(json.dumps({{'type':'result','session_id':{THREAD!r},'is_error':False,'result':{PRIVATE!r}}}))"
        )
        with patch.object(dispatch.time, "time", return_value=130):
            dispatch.dispatch(
                self.root, path, [sys.executable, "-c", transport], reporter=reporter
            )
        self.assertEqual(json.loads(receipt_path.read_text())["status"], "completed")
        self.assertEqual(self.events("amp-task")[-1]["attempt"], 2)
        self.assertEqual(self.events("amp-task")[-1]["threadId"], THREAD)
        self.assertNotIn(PRIVATE, json.dumps(self.events()))
        with (
            patch.object(reporter, "controller", side_effect=OSError(PRIVATE)),
            patch.object(reporter, "dispatch", side_effect=OSError(PRIVATE)),
            patch("builtins.print", side_effect=BrokenPipeError(PRIVATE)),
        ):
            store.set("operatorHold", "owner")
            receipt_path.unlink()
            dispatch.dispatch(
                self.root,
                path,
                [sys.executable, "-c", "raise SystemExit(1)"],
                reporter=reporter,
            )
        self.assertEqual(store.get("operatorHold"), "owner")
        self.assertEqual(json.loads(receipt_path.read_text())["status"], "queued")

    def test_recovery_links_survive_reconciliation_and_backfill_is_idempotent(self):
        reporter = self.reporter()
        store = self.store(reporter)
        recovery = deploy.Recovery(store)
        recovery.flush()
        store.event(REVISION, "failed", "preflight_failed")
        with patch.object(deploy.subprocess, "run"):
            recovery.flush()
        number = json.loads(store.get("recovery"))["incident"]
        fake = Mock()
        fake.__enter__ = Mock(return_value=fake)
        fake.__exit__ = Mock(return_value=False)
        fake.stdout = io.StringIO(
            json.dumps({"type": "system", "subtype": "init", "session_id": THREAD})
            + '\n{"text":"'
            + PRIVATE
            + '"}\n'
        )
        with patch.object(deploy.subprocess, "Popen", return_value=fake) as spawn:
            config = {
                "ampRecovery": {
                    "command": ["/fixture/amp"],
                    "runnerDirectory": "/fixture",
                }
            }
            deploy.dispatch_recovery(
                config, number, self.root / "records/deploy.sqlite", reporter=reporter
            )
            deploy.dispatch_recovery(
                config, number, self.root / "records/deploy.sqlite", reporter=reporter
            )
            self.assertEqual(spawn.call_count, 1)
        recovery.claim(number, THREAD)
        host = Mock(blue_green=False)
        deploy.Deployer(host, store).reconcile(REVISION, THREAD)
        self.assertEqual(store.get("recovery"), "")
        events = self.events("recovery")
        self.assertEqual(
            [event["status"] for event in events],
            ["pending", "dispatching", "spawned", "claimed", "reconciled"],
        )
        self.assertEqual(events[-1]["threadId"], THREAD)
        self.assertEqual(events[-1]["relatedOperationId"], "deployment:" + REVISION)
        self.assertEqual([event["sequence"] for event in events], list(range(5)))
        self.assertTrue(
            any(
                event["controller"]["recoveryOwner"] == THREAD
                for event in self.events("controller")
            )
        )
        before = self.events("deployment")
        reporter.backfill(store)
        reporter.backfill(store)
        self.assertEqual(self.events("deployment"), before)
        self.assertNotIn(PRIVATE, json.dumps(self.events()))

    def test_controller_projection_is_bounded_content_free_and_heartbeats_coalesce(
        self,
    ):
        reporter = self.reporter()
        store = self.store(reporter)
        store.set("operatorHold", PRIVATE)
        store.set(
            "queue", json.dumps({"pending": [f"{index:040x}" for index in range(70)]})
        )
        store.set(
            "retry", json.dumps({"attempts": 3, "after": 100.5, "reason": PRIVATE})
        )
        store.block(REVISION, PRIVATE)
        event = self.events("controller")[-1]
        self.assertTrue(event["controller"]["operatorHold"])
        self.assertEqual(len(event["controller"]["queuedRevisions"]), 50)
        self.assertEqual(event["controller"]["omittedQueueCount"], 20)
        self.assertEqual(event["controller"]["retryAt"], 100500)
        self.assertNotIn(PRIVATE, json.dumps(self.events()))
        count = len(self.events("controller"))
        reporter.controller(store)
        self.assertEqual(len(self.events("controller")), count)
        with patch.object(self.ops.time, "time", return_value=9_000_000_000):
            reporter.controller(store)
        self.assertEqual(len(self.events("controller")), count + 1)

    def test_dispatch_unknown_without_thread_and_reporting_faults_preserve_policy(self):
        for broken in (False, True):
            with self.subTest(broken=broken):
                reporter = self.reporter()
                path = self.root / f"{IDENTITY}.task.json"
                path.write_text(
                    json.dumps(
                        {
                            "id": IDENTITY,
                            "kind": "amp-task",
                            "title": PRIVATE,
                            "prompt": PRIVATE,
                            "ownerRequest": PRIVATE,
                        }
                    )
                )
                path.chmod(0o600)
                receipt_path = self.root / f"{IDENTITY}.receipt.json"
                receipt_path.unlink(missing_ok=True)
                transport = (
                    "import sys; print(sys.argv[1], flush=True); sys.stdin.read()"
                )
                context = (
                    patch.object(reporter, "dispatch", side_effect=OSError(PRIVATE))
                    if broken
                    else patch.object(reporter, "start")
                )
                with context:
                    dispatch.dispatch(
                        self.root,
                        path,
                        [sys.executable, "-c", transport],
                        reporter=reporter,
                    )
                    dispatch.dispatch(
                        self.root, path, ["/must/not/relaunch"], reporter=reporter
                    )
                self.assertEqual(
                    json.loads(receipt_path.read_text()),
                    {"id": IDENTITY, "status": "unknown"},
                )
        events = self.events("amp-task")
        self.assertEqual(
            [event["status"] for event in events],
            ["queued", "queued", "running", "unknown"],
        )
        self.assertNotIn("threadId", events[-1])
        self.assertNotIn(PRIVATE, json.dumps(events))

    def test_dispatch_startup_backfill_unknown_time_and_running_fence(self):
        reporter = self.reporter()
        path = self.root / f"{IDENTITY}.json"
        path.write_text(
            json.dumps(
                {
                    "id": IDENTITY,
                    "revision": REVISION,
                    "capturedAt": "2000-01-01T00:00:00Z",
                    "reason": PRIVATE,
                }
            )
        )
        path.chmod(0o600)
        dispatch.save_receipt(
            self.root, {"id": IDENTITY, "status": "running", "threadId": THREAD}
        )
        dispatch.recover_receipts(self.root, reporter)
        dispatch.recover_receipts(self.root, reporter)
        events = self.events("debugshare")
        self.assertEqual(
            [event["status"] for event in events], ["queued", "running", "unknown"]
        )
        self.assertEqual([event["occurredAt"] for event in events[:2]], [None, None])
        self.assertIsInstance(events[-1]["occurredAt"], int)
        self.assertEqual(events[-1]["snapshotId"], IDENTITY)
        self.assertEqual(events[-1]["revision"], REVISION)
        path.write_text(json.dumps({"id": IDENTITY, "snapshotOnly": True}))
        (self.root / f"{IDENTITY}.receipt.json").unlink()
        with patch.object(dispatch.subprocess, "Popen") as launch:
            dispatch.dispatch(self.root, path, ["/must/not/launch"], reporter=reporter)
            launch.assert_not_called()
        self.assertEqual(self.events("debugshare"), events)

    def test_invalid_reporting_config_disables_only_reporting_and_isolated_load_works(
        self,
    ):
        self.reporter()
        for origin in (
            "http://example.test",
            "https://debug.example.test/",
            "https://user:pass@debug.example.test",
            "https://debug.example.test:443",
            "https://debug.example.test/#private",
            "https://127.1",
            "https://0x7f000001",
            "https://[fe80::1%eth0]",
        ):
            with self.subTest(origin=origin), self.assertRaises(ValueError):
                self.ops.Reporter({**self.config, "origin": origin})
        for filename in ("tokenFile", "database"):
            path = Path(self.config[filename])
            path.chmod(0o644)
            with self.assertRaises(ValueError):
                self.ops.Reporter(self.config)
            path.chmod(0o600)
            alias = path.with_name(path.name + "-link")
            alias.symlink_to(path)
            with self.assertRaises(ValueError):
                self.ops.Reporter({**self.config, filename: str(alias)})
        with self.assertRaises(ValueError):
            self.reporter().dispatch(
                IDENTITY,
                False,
                {"id": IDENTITY},
                {"id": "wrong", "status": "completed"},
                phase="receipt",
                backfill=True,
            )
        for module in (deploy, dispatch):
            with patch("builtins.print") as output:
                self.assertIsNone(
                    module.operations_reporter({**self.config, "origin": PRIVATE})
                )
            self.assertNotIn(PRIVATE, str(output.call_args_list))
        script = "import importlib.util, pathlib; p=pathlib.Path(__import__('sys').argv[1]); s=importlib.util.spec_from_file_location('source',p); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); r=m.operations_reporter(__import__('json').loads(__import__('sys').argv[2])); assert r is not None; r.close()"
        for name in ("deploy.py", "debugshare.py"):
            # A private loopback endpoint is intentionally absent; never touch a collector.
            config = {
                **self.config,
                "origin": "http://127.0.0.1:1",
                "database": str(self.root / f"{name}-isolated.sqlite"),
            }
            subprocess.run(
                [
                    sys.executable,
                    "-I",
                    "-B",
                    "-c",
                    script,
                    str(Path(__file__).with_name(name)),
                    json.dumps(config),
                ],
                check=True,
                timeout=5,
            )


if __name__ == "__main__":
    os.umask(0o077)
    unittest.main()
