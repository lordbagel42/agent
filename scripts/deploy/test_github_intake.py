"""Security and replay boundary; disposable SQLite, HTTP and Unix sockets only."""

import hashlib
import hmac
import http.client
import importlib.util
import json
import socket
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "github_intake", Path(__file__).with_name("github_intake.py")
)
intake = importlib.util.module_from_spec(spec)
spec.loader.exec_module(intake)


class GitHubIntakeSafety(unittest.TestCase):
    def test_signed_receipt_is_durable_before_wake_and_replay_keeps_identity(self):
        secret = "synthetic-fixture-secret-32-characters"
        payload = {
            "repository": {"full_name": "lordbagel42/agent"},
            "installation": {"id": 456},
            "ref": "refs/heads/main",
            "deleted": False,
        }
        body = json.dumps(payload).encode()
        signature = (
            "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
        )
        with (
            tempfile.TemporaryDirectory() as tmp,
            socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as wake,
        ):
            wake.bind(tmp + "/wake")
            wake.settimeout(0.05)
            inbox = intake.Inbox(tmp + "/inbox.sqlite", secret, 456)
            with inbox.connect() as db:
                db.execute("CREATE TABLE state(key TEXT PRIMARY KEY,value TEXT)")
            server = intake.Server(("127.0.0.1", 0), intake.Handler)
            server.inbox = inbox
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                with (
                    patch.object(intake, "WAKE_SOCKET", tmp + "/wake"),
                    patch.object(intake, "CONTROLLER_DB", tmp + "/inbox.sqlite"),
                ):
                    connection = http.client.HTTPConnection(
                        *server.server_address, timeout=2
                    )
                    headers = {
                        "X-GitHub-Delivery": "delivery-1",
                        "X-GitHub-Event": "push",
                        "X-Hub-Signature-256": signature,
                    }
                    connection.request("POST", "/webhooks/github", body + b" ", headers)
                    response = connection.getresponse()
                    self.assertEqual(response.status, 401)
                    response.read()
                    connection.close()
                    with inbox.connect() as db:
                        self.assertEqual(
                            db.execute("SELECT COUNT(*) FROM deliveries").fetchone()[0],
                            0,
                        )
                    self.assertEqual(
                        inbox.receive("delivery-1", "push", signature, body), 202
                    )
                    self.assertEqual(wake.recv(64), b"github")
                    reopened = intake.Inbox(tmp + "/inbox.sqlite", secret, 456)
                    with reopened.connect() as db:
                        self.assertEqual(
                            db.execute("SELECT body FROM deliveries").fetchone()[0],
                            body,
                        )
                    self.assertEqual(
                        reopened.receive("delivery-1", "push", signature, body), 202
                    )
                    self.assertEqual(
                        reopened.receive("delivery-1", "issues", signature, body), 409
                    )
                    with self.assertRaises(TimeoutError):
                        wake.recv(64)
                    with patch.object(intake, "MAX_PENDING_BYTES", len(body)):
                        self.assertEqual(
                            reopened.receive("delivery-2", "push", signature, body), 503
                        )
                received = []

                class App(BaseHTTPRequestHandler):
                    def log_message(self, *_args):
                        pass

                    def do_POST(self):
                        received.append(
                            (
                                self.headers["X-GitHub-Delivery"],
                                self.rfile.read(int(self.headers["Content-Length"])),
                            )
                        )
                        self.send_response(503 if len(received) == 1 else 202)
                        self.end_headers()
                        self.wfile.write(b'{"accepted":true}')

                app = HTTPServer(("127.0.0.1", 0), App)
                app_thread = threading.Thread(target=app.serve_forever, daemon=True)
                app_thread.start()
                try:
                    origin = f"http://127.0.0.1:{app.server_port}"
                    self.assertFalse(reopened.forward_one(origin))
                    self.assertTrue(reopened.forward_one(origin))
                    self.assertFalse(reopened.forward_one(origin))
                    self.assertEqual(
                        received, [("delivery-1", body), ("delivery-1", body)]
                    )
                    with reopened.connect() as db:
                        self.assertIsNone(
                            db.execute("SELECT body FROM deliveries").fetchone()[0]
                        )
                    with (
                        patch.object(intake, "WAKE_SOCKET", tmp + "/wake"),
                        patch.object(intake, "CONTROLLER_DB", tmp + "/inbox.sqlite"),
                    ):
                        for key in ("recovery", "blocked", "operatorHold"):
                            with reopened.connect() as db:
                                db.execute("DELETE FROM state")
                                db.execute(
                                    "INSERT INTO state VALUES (?,?)", (key, "fenced")
                                )
                            self.assertEqual(
                                reopened.receive(key, "push", signature, body), 202
                            )
                            with self.assertRaises(TimeoutError):
                                wake.recv(64)
                        with reopened.connect() as db:
                            self.assertEqual(
                                db.execute(
                                    "SELECT COUNT(*) FROM deliveries WHERE body IS NOT NULL"
                                ).fetchone()[0],
                                3,
                            )
                finally:
                    app.shutdown()
                    app_thread.join()
                    app.server_close()
            finally:
                server.shutdown()
                thread.join()
                server.server_close()

    def test_unrelated_signed_events_forward_but_do_not_wake_deployment(self):
        secret = "synthetic-fixture-secret-32-characters"
        with (
            tempfile.TemporaryDirectory() as tmp,
            socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as wake,
        ):
            wake.bind(tmp + "/wake")
            wake.settimeout(0.05)
            inbox = intake.Inbox(tmp + "/inbox.sqlite", secret, 456)
            payload = {
                "repository": {"full_name": "lordbagel42/other"},
                "installation": {"id": 456},
                "ref": "refs/heads/main",
                "deleted": False,
            }
            with patch.object(intake, "WAKE_SOCKET", tmp + "/wake"):
                for number, change in enumerate(
                    (
                        {},
                        {
                            "repository": {"full_name": "lordbagel42/agent"},
                            "installation": {"id": 999},
                        },
                        {
                            "repository": {"full_name": "lordbagel42/agent"},
                            "ref": "refs/heads/feature",
                        },
                    )
                ):
                    body = json.dumps({**payload, **change}).encode()
                    signature = (
                        "sha256="
                        + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
                    )
                    self.assertEqual(
                        inbox.receive(f"id-{number}", "push", signature, body), 202
                    )
                with self.assertRaises(TimeoutError):
                    wake.recv(64)
                with inbox.connect() as db:
                    self.assertEqual(
                        db.execute(
                            "SELECT COUNT(*) FROM deliveries WHERE body IS NOT NULL"
                        ).fetchone()[0],
                        3,
                    )

    def test_slow_unsigned_upload_cannot_block_a_signed_delivery(self):
        secret = "synthetic-fixture-secret-32-characters"
        with (
            tempfile.TemporaryDirectory() as tmp,
            patch.object(intake, "REQUEST_SECONDS", 0.5),
        ):
            server = intake.Server(("127.0.0.1", 0), intake.Handler)
            server.inbox = intake.Inbox(tmp + "/inbox.sqlite", secret, 456)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                with socket.create_connection(server.server_address, timeout=2) as slow:
                    slow.sendall(
                        b"POST /webhooks/github HTTP/1.1\r\nHost: localhost\r\nContent-Length: 1000\r\n\r\n{"
                    )
                    body = b"{}"
                    signature = (
                        "sha256="
                        + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
                    )
                    connection = http.client.HTTPConnection(
                        *server.server_address, timeout=0.3
                    )
                    connection.request(
                        "POST",
                        "/webhooks/github",
                        body,
                        {
                            "X-GitHub-Delivery": "fast",
                            "X-GitHub-Event": "ping",
                            "X-Hub-Signature-256": signature,
                        },
                    )
                    response = connection.getresponse()
                    self.assertEqual(response.status, 202)
                    self.assertFalse(json.loads(response.read())["deploymentAdmitted"])
                    connection.close()
                    # Keep the read active: only the absolute deadline can end it.
                    for _ in range(4):
                        time.sleep(0.1)
                        slow.sendall(b" ")
                    self.assertEqual(slow.recv(1), b"")
            finally:
                server.shutdown()
                thread.join()
                server.server_close()


if __name__ == "__main__":
    unittest.main()
