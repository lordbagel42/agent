"""Metadata exporter boundaries; all source files, SQLite and HTTP are disposable."""

import importlib.util
import json
import os
import sqlite3
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

IDENTITY = "12345678-1234-4234-8234-123456789abc"
THREAD = "T-12345678-1234-4234-8234-123456789abc"


class SourceStatus(unittest.TestCase):
    def setUp(self):
        path = Path(__file__).with_name("source_status.py")
        self.assertTrue(path.exists(), "metadata exporter not implemented")
        spec = importlib.util.spec_from_file_location("source_status", path)
        self.source = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.source)
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.debug = self.root / "debug"
        self.debug.mkdir(mode=0o700)
        records = self.root / "records"
        records.mkdir(mode=0o700)
        self.database = records / "deploy.sqlite"
        with sqlite3.connect(self.database) as db:
            db.execute("CREATE TABLE state(key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        self.database.chmod(0o600)
        self.config = {
            "origin": "https://debug.raygen.dev",
            "tokenFile": str(self.root / "token"),
            "debugDirectory": str(self.debug),
            "recoveryDatabase": str(self.database),
        }
        self.calls = []
        self.root_owner = patch.object(self.source, "ROOT_UID", os.getuid())
        self.root_owner.start()
        self.addCleanup(self.root_owner.stop)

    def receipt(self, identity=IDENTITY, **fields):
        path = self.debug / f"{identity}.receipt.json"
        path.write_text(json.dumps({"id": identity, "kind": "debugshare", **fields}))
        path.chmod(0o600)
        return path

    def recovery(self, number=17, **fields):
        source = f"recovery:{number}"
        with sqlite3.connect(self.database) as db:
            db.execute(
                "INSERT OR REPLACE INTO state VALUES (?,?)",
                (
                    "issue-source:" + source,
                    json.dumps({"source": source, **fields}),
                ),
            )

    def api(self, path, payload):
        self.assertEqual(path, "/api/issue-sources")
        self.assertLessEqual(set(payload), {"source", "phase", "threadId", "revision"})
        self.assertNotIn("PRIVATE", json.dumps(payload))
        # No SQLite read transaction can remain across HTTP, even for recovery.
        if self.database.exists():
            with sqlite3.connect(
                self.database.as_uri() + "?mode=rw", uri=True, timeout=0
            ) as db:
                db.execute("BEGIN EXCLUSIVE")
        self.calls.append(payload.copy())
        return {"ok": True}

    def exporter(self, api=None):
        exporter = self.source.Exporter(self.config, api or self.api, os.getuid())
        self.addCleanup(exporter.close)
        return exporter

    def test_receipt_mapping_does_not_open_snapshots_or_export_task_results(self):
        expected = {}
        for index, (status, extra, phase) in enumerate(
            (
                ("queued", {"retryAt": 123}, "queued"),
                ("running", {}, "running"),
                ("running", {"threadId": THREAD}, "running"),
                ("completed", {"threadId": THREAD}, "returned"),
                ("completed", {"threadId": THREAD, "resolved": True}, "returned"),
                ("unknown", {"threadId": THREAD}, "unknown"),
                ("completed", {}, "unknown"),
            )
        ):
            identity = f"12345678-1234-4234-8234-{index:012d}"
            self.receipt(identity, status=status, **extra)
            expected[f"debug:{identity}"] = {
                "source": f"debug:{identity}",
                "phase": phase,
                **({"threadId": THREAD} if "threadId" in extra else {}),
            }
        self.receipt(
            status="completed",
            kind="amp-task",
            threadId=THREAD,
            result={"text": "PRIVATE_TASK_RESULT"},
        )
        # An old untyped receipt needs a diagnostic filename, never its contents.
        legacy = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        self.receipt(legacy, kind=None, status="unknown")
        original = self.debug / f"{legacy}.json"
        original.write_text("PRIVATE_SNAPSHOT: deliberately not JSON")
        original.chmod(0o600)
        expected[f"debug:{legacy}"] = {"source": f"debug:{legacy}", "phase": "unknown"}
        read = self.source.issues.read_private

        def metadata_only(path, **kwargs):
            self.assertTrue(str(path).endswith(".receipt.json"))
            return read(path, **kwargs)

        with patch.object(
            self.source.issues, "read_private", side_effect=metadata_only
        ):
            self.exporter().poll_once()
        self.assertEqual({item["source"]: item for item in self.calls}, expected)
        # A colliding .task.json (even a dangling symlink) excludes a legacy share.
        (self.debug / f"{legacy}.task.json").symlink_to(self.root / "missing")
        self.calls.clear()
        self.exporter().poll_once()
        self.assertNotIn(f"debug:{legacy}", [item["source"] for item in self.calls])

    def test_unsafe_oversized_malformed_or_unclassified_receipts_are_skipped(self):
        path = self.receipt(status="running")
        exporter = self.exporter()
        for value in (
            [],
            {"id": IDENTITY, "status": "running"},
            {"id": IDENTITY, "kind": "amp-task", "status": "unknown"},
            {"id": IDENTITY, "kind": "debugshare", "status": []},
            {
                "id": IDENTITY,
                "kind": "debugshare",
                "status": "completed",
                "threadId": THREAD,
                "resolved": "true",
            },
            {
                "id": IDENTITY,
                "kind": "debugshare",
                "status": "completed",
                "threadId": "T-" + "-" * 36,
            },
            {
                "id": IDENTITY,
                "kind": "debugshare",
                "status": "completed",
                "result": "PRIVATE",
            },
        ):
            path.write_text(json.dumps(value))
            exporter.poll_once()
        path.write_bytes(b" " * 65537)
        exporter.poll_once()
        path.unlink()
        os.mkfifo(path, 0o600)
        exporter.poll_once()
        path.unlink()
        path = self.receipt(status="running")
        path.chmod(0o644)
        exporter.poll_once()
        path.chmod(0o600)
        target = path.with_suffix(".saved")
        path.rename(target)
        path.symlink_to(target)
        exporter.poll_once()
        path.unlink()
        os.link(target, path)
        exporter.poll_once()
        self.assertEqual(self.calls, [])

    def test_failure_restart_and_newer_status_retry_only_current_metadata(self):
        path = self.receipt(status="queued", retryAt=1)
        self.recovery(phase="unknown", revision="a" * 40, threadId=THREAD)
        fail = True

        def api(endpoint, payload):
            reply = self.api(endpoint, payload)
            if fail:
                raise self.source.issues.IssueError("issue_request_unknown")
            return reply

        exporter = self.exporter(api)
        exporter.poll_once()
        self.assertEqual(len(self.calls), 2)
        self.assertEqual(len(exporter.acknowledged), 0)
        self.receipt(status="completed", threadId=THREAD)
        fail = False
        exporter.poll_once()
        self.assertEqual(self.calls[-2]["phase"], "returned")
        self.assertEqual(len(exporter.acknowledged), 2)
        exporter.poll_once()
        self.assertEqual(len(self.calls), 4)
        # Stale receipts cannot undo a status acknowledged in this process.
        self.receipt(status="queued", retryAt=2)
        exporter.poll_once()
        self.assertEqual(len(self.calls), 4)
        self.receipt(status="completed", threadId=THREAD)
        exporter.close()
        self.exporter().poll_once()  # No durable ack cache, source evidence survives.
        self.assertEqual(len(self.calls), 6)
        self.assertEqual(json.loads(path.read_text())["status"], "completed")
        with sqlite3.connect(self.database) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM state").fetchone()[0], 1)

    def test_recovery_validation_and_failures_are_independent_of_debug(self):
        self.receipt(status="unknown")
        self.recovery(phase="returned")  # No verified thread is not a return.
        self.recovery(18, phase="running", threadId="not-a-thread")
        self.recovery(19, phase="unknown", reason="PRIVATE_REASON")
        self.recovery(20, phase="returned", threadId=THREAD, revision="b" * 40)
        exporter = self.exporter()
        exporter.poll_once()
        self.assertEqual(
            {item["source"] for item in self.calls},
            {f"debug:{IDENTITY}", "recovery:20"},
        )
        self.database.unlink()
        self.calls.clear()
        self.exporter().poll_once()
        self.assertEqual(
            self.calls, [{"source": f"debug:{IDENTITY}", "phase": "unknown"}]
        )
        self.assertFalse(self.database.exists())

    def test_symlink_loop_in_one_source_does_not_block_the_other(self):
        self.recovery(phase="unknown")
        exporter = self.exporter()
        self.debug.rmdir()
        self.debug.symlink_to(self.debug)
        exporter.poll_once()
        self.assertEqual(self.calls, [{"source": "recovery:17", "phase": "unknown"}])

    def test_scan_and_ack_cache_are_bounded_and_pages_make_progress(self):
        for index in range(1, 8):
            self.receipt(f"12345678-1234-4234-8234-{index:012d}", status="queued")
            self.recovery(index, phase="queued")
        with (
            patch.object(self.source, "BATCH_SIZE", 2),
            patch.object(self.source, "CACHE_SIZE", 3),
        ):
            exporter = self.exporter()
            for _ in range(8):
                before = len(self.calls)
                exporter.poll_once()
                self.assertLessEqual(len(self.calls) - before, 4)
                self.assertLessEqual(len(exporter.acknowledged), 3)
        self.assertEqual(len({item["source"] for item in self.calls}), 14)

    def test_config_has_no_command_surface_and_private_files_require_owner(self):
        for config in (
            {**self.config, "command": ["/bin/sh"]},
            {**self.config, "origin": "http://untrusted.example"},
            {**self.config, "debugDirectory": "relative"},
        ):
            with self.assertRaises(ValueError):
                self.source.validate_config(config)
        alias = self.root / "alias"
        alias.symlink_to(self.debug)
        with self.assertRaises(ValueError):
            self.source.validate_config({**self.config, "debugDirectory": str(alias)})
        path = self.receipt(status="running")
        with self.assertRaises(ValueError):
            self.source.issues.read_private(path, owner=os.getuid() + 1)

    def test_real_client_posts_only_metadata_with_auth_and_retries_failed_ack(self):
        received = []

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_POST(self):
                received.append(
                    (
                        self.path,
                        self.headers.get("Authorization"),
                        json.loads(
                            self.rfile.read(int(self.headers["Content-Length"]))
                        ),
                    )
                )
                self.send_response(503 if len(received) == 1 else 200)
                self.end_headers()
                self.wfile.write(b'{"ok":true}')

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        worker = threading.Thread(target=server.serve_forever)
        worker.start()
        try:
            token = Path(self.config["tokenFile"])
            token.write_text("fixture-automation-token")
            token.chmod(0o600)
            self.config["origin"] = f"http://127.0.0.1:{server.server_port}"
            read = self.source.issues.read_private
            with patch.object(
                self.source.issues,
                "read_private",
                side_effect=lambda path, **kw: read(
                    path, **{**kw, "owner": os.getuid()}
                ),
            ):
                client = self.source.issues.Client(self.config)
            self.receipt(status="completed", threadId=THREAD)
            exporter = self.exporter(client.post)
            exporter.poll_once()
            self.assertEqual(len(exporter.acknowledged), 0)
            exporter.poll_once()
            exporter.poll_once()
            self.assertEqual(
                received,
                [
                    (
                        "/api/issue-sources",
                        "Bearer fixture-automation-token",
                        {
                            "source": f"debug:{IDENTITY}",
                            "phase": "returned",
                            "threadId": THREAD,
                        },
                    )
                ]
                * 2,
            )
        finally:
            server.shutdown()
            server.server_close()
            worker.join()


if __name__ == "__main__":
    os.umask(0o077)
    unittest.main()
