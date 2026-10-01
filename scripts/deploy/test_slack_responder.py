"""Safety boundaries and duplicate effects, using only disposable local state."""

import hashlib
import hmac
import http.client
import json
import sqlite3
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack, closing
from http.server import BaseHTTPRequestHandler, HTTPServer, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import Mock, patch
from urllib.parse import urlencode

from deploy import Deployer, Host, Store
from slack_responder import CONTROL_PATH, Responder, Server

TARGET = "abc1234" + "9" * 33
OLD = "5" * 40
CONFIG = {
    "teamId": "T1",
    "botUserId": "UBOT",
    "signingSecret": "fixture",
    "botToken": "not-a-token",
}


def signed(payload, age=0):
    raw = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
    stamp = str(int(time.time()) - age)
    signature = hmac.new(
        b"fixture", b"v0:" + stamp.encode() + b":" + raw, hashlib.sha256
    ).hexdigest()
    return raw, {
        "content-type": "application/json",
        "x-slack-request-timestamp": stamp,
        "x-slack-signature": "v0=" + signature,
    }


def event(number, **changes):
    return {
        "type": "event_callback",
        "team_id": "T1",
        "event_id": f"Ev{number}",
        "event": {
            "type": "message",
            "channel": "C1",
            "user": "U1",
            "ts": f"1790424123.{number:06}",
            "text": "<@UBOT> hello",
            **changes,
        },
    }


class ResponderTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.marker = self.root / "slack-responder.json"
        self.database = self.root / "handled.sqlite"
        self.set_marker(TARGET)
        self.responder = Responder(CONFIG, self.marker, self.database)
        self.addCleanup(lambda: self.responder.db.close())
        self.responder.forward = Mock(return_value=(202, b"upstream", "text/plain"))

    def set_marker(self, revision, blocked=False):
        self.marker.write_text(
            json.dumps({"version": 1, "revision": revision, "blocked": blocked})
        )

    def test_explicit_private_bind_forwards_original_signed_request(self):
        received = []

        class Upstream(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                received.append(
                    (
                        self.path,
                        self.rfile.read(int(self.headers["content-length"])),
                        self.headers["x-slack-signature"],
                    )
                )
                self.send_response(202)
                self.end_headers()
                self.wfile.write(b"forwarded")

        # A different loopback address catches hard-coded 127.0.0.1 routing.
        upstream = HTTPServer(("127.0.0.2", 0), Upstream)
        worker = threading.Thread(target=upstream.serve_forever, daemon=True)
        worker.start()
        self.set_marker(None)
        responder = Responder(
            {**CONFIG, "host": "127.0.0.2", "upstreamPort": upstream.server_port},
            self.marker,
            ":memory:",
        )
        server = Server(0, responder)
        try:
            self.assertEqual(server.server_address[0], "127.0.0.2")
            raw, headers = signed(event(41))
            self.assertEqual(responder.receive(raw, headers)[:2], (202, b"forwarded"))
            self.assertEqual(
                received, [("/webhooks/slack", raw, headers["x-slack-signature"])]
            )
        finally:
            server.server_close()
            responder.db.close()
            upstream.shutdown()
            worker.join()
            upstream.server_close()

        for host in ("0.0.0.0", "example.com", "8.8.8.8", "::", "::1"):
            with self.subTest(host=host), self.assertRaises(ValueError):
                Responder({**CONFIG, "host": host}, self.marker, ":memory:")

    def test_authentication_and_narrow_reply_audience(self):
        raw, headers = signed(event(1))
        self.assertEqual(self.responder.receive(raw + b" ", headers)[0], 401)
        self.assertEqual(self.responder.receive(*signed(event(1), age=301))[0], 401)
        self.assertEqual(
            self.responder.receive(*signed({**event(1), "team_id": "T2"}))[0], 403
        )
        variants = [
            {"text": "June hello"},
            {"text": "<!here>"},
            {"text": "ordinary followup", "thread_ts": "1790424000.000009"},
            {"text": "group DM", "channel_type": "mpim"},
            {"bot_id": "B1"},
            {"app_id": "A1"},
            {"user": "UBOT"},
            {"subtype": "message_changed"},
            {"subtype": "message_deleted"},
            {"hidden": True},
            {"type": "reaction_added"},
            {"type": "app_mention", "text": "no direct mention"},
        ]
        for number, variant in enumerate(variants, 10):
            self.assertEqual(
                self.responder.receive(*signed(event(number, **variant)))[0], 200
            )
        mention = self.responder.receive(*signed(event(30, type="app_mention")))
        self.assertEqual(
            mention,
            {
                "channel": "C1",
                "thread_ts": "1790424123.000030",
                "text": f"currently deploying <https://github.com/lordbagel42/agent/commit/{TARGET}|abc1234>",
                "unfurl_links": False,
                "unfurl_media": False,
            },
        )
        dm = self.responder.receive(
            *signed(event(31, channel="D1", channel_type="im", text="hello"))
        )
        self.assertNotIn("thread_ts", dm)
        self.assertEqual(dm["text"], mention["text"])
        threaded = self.responder.receive(
            *signed(
                event(
                    32, channel_type="im", text="hello", thread_ts="1790424000.000009"
                )
            )
        )
        self.assertEqual(threaded["thread_ts"], "1790424000.000009")
        self.responder.forward.assert_not_called()

    def test_durable_claim_covers_concurrency_dual_events_and_reopen(self):
        payload = event(1, subtype="file_share")
        with ThreadPoolExecutor(max_workers=8) as pool:
            replies = list(
                pool.map(lambda _: self.responder.receive(*signed(payload)), range(8))
            )
        self.assertEqual(sum(isinstance(reply, dict) for reply in replies), 1)
        # Claim survives process loss before/after Slack acceptance. No replay,
        # including the app_mention copy with a different envelope event ID.
        self.responder.db.close()
        self.responder = Responder(CONFIG, self.marker, self.database)
        self.responder.forward = Mock(return_value=(202, b"", "text/plain"))
        self.set_marker(None)
        self.assertEqual(self.responder.receive(*signed(payload))[0], 200)
        self.assertEqual(
            self.responder.receive(
                *signed({**event(1, type="app_mention"), "event_id": "EvOther"})
            )[0],
            200,
        )
        self.responder.forward.assert_not_called()
        self.assertEqual(self.responder.receive(*signed(event(2)))[0], 202)
        self.assertEqual(self.responder.forward.call_count, 1)
        for number, subtype in enumerate(("me_message", "thread_broadcast"), 10):
            for offset, reverse in enumerate((False, True)):
                original = event(number * 10 + offset, subtype=subtype)
                mention = {
                    **event(number * 10 + offset, type="app_mention"),
                    "event_id": f"EvMention{number}{offset}",
                }
                first, second = (mention, original) if reverse else (original, mention)
                self.set_marker(TARGET)
                self.assertIsInstance(self.responder.receive(*signed(first)), dict)
                self.set_marker(None)
                self.assertEqual(self.responder.receive(*signed(second))[0], 200)
        self.assertEqual(self.responder.forward.call_count, 1)

    def test_real_http_ack_precedes_send_and_missing_state_never_forwards(self):
        entered, finish, settled = (
            threading.Event(),
            threading.Event(),
            threading.Event(),
        )

        def send(_):
            entered.set()
            finish.wait(5)
            settled.set()
            raise TimeoutError("fixture lost acknowledgement")

        self.responder.send = Mock(side_effect=send)
        server = Server(0, self.responder)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()

        def post(payload):
            raw, headers = signed(payload)
            connection = http.client.HTTPConnection(*server.server_address, timeout=1)
            try:
                connection.request("POST", "/webhooks/slack", raw, headers)
                response = connection.getresponse()
                response.read()
                return response.status
            finally:
                connection.close()

        try:
            self.assertEqual(post(event(1)), 200)
            self.assertTrue(entered.wait(1))
            self.assertEqual(post(event(1)), 200)
            self.assertEqual(self.responder.send.call_count, 1)
            self.set_marker(TARGET, blocked=True)
            self.assertEqual(post(event(2)), 503)
            self.marker.unlink()
            self.assertEqual(post(event(3)), 503)
            self.responder.forward.assert_not_called()
            finish.set()
            self.assertTrue(settled.wait(1))
            self.set_marker(None)
            self.assertEqual(post(event(1)), 200)
            self.responder.forward.assert_not_called()
        finally:
            finish.set()
            server.shutdown()
            worker.join()
            server.server_close()

    def test_controller_marker_tracks_intent_not_newer_observed_head(self):
        store = Store(
            self.root / "records",
            self.root / "events.json",
            OLD,
            slack_responder_feed=True,
        )
        self.addCleanup(store.close)
        read = lambda: json.loads(self.marker.read_text())
        self.assertIsNone(read()["revision"])
        store.event(TARGET, "preparing")
        self.assertIsNone(read()["revision"])
        store.set("intent", TARGET)
        store.set("observed", "7" * 40)
        store.event("7" * 40, "received")
        self.assertEqual(read(), {"version": 1, "revision": TARGET, "blocked": False})
        store.block(TARGET, "activation_unknown")
        self.assertTrue(read()["blocked"])
        store.event(OLD, "reconciled")
        self.assertEqual(read(), {"version": 1, "revision": None, "blocked": False})
        store.set("intent", TARGET)
        store.event(TARGET, "healthy")
        self.assertIsNone(read()["revision"])
        store.set("intent", TARGET)
        host = Mock()
        host.resume.return_value = True
        # Exercise the real resume path without the constructor's recovery work.
        controller = object.__new__(Deployer)
        controller.host, controller.store = host, store
        controller.resume(TARGET)
        self.assertIsNone(read()["revision"])
        store.set("intent", TARGET)
        host.resume.return_value = False
        controller.resume(TARGET)
        self.assertEqual(read(), {"version": 1, "revision": TARGET, "blocked": True})


class DurableIntakeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.database = Path(self.temp.name) / "intake.sqlite"
        self.config = {
            **CONFIG,
            "durableQueue": {"token": "private-fixture-" + "x" * 32, "maxEvents": 2},
        }
        self.auth = {"authorization": "Bearer " + self.config["durableQueue"]["token"]}
        self.responder = Responder(self.config, "/missing-marker", self.database)
        self.addCleanup(lambda: self.responder.db.close())
        self.addCleanup(lambda: self.responder.stop())

    def serve(self):
        server = Server(0, self.responder)
        thread = threading.Thread(target=server.serve_forever)
        thread.start()

        def close():
            server.shutdown()
            thread.join()
            server.server_close()

        self.addCleanup(close)
        return server.server_address

    def request(self, address, method, path, raw=None, headers=None):
        connection = http.client.HTTPConnection(*address, timeout=3)
        try:
            connection.request(method, path, raw, headers or {})
            response = connection.getresponse()
            return response.status, response.read()
        finally:
            connection.close()

    def rows(self, table):
        # Independent connection proves acceptance crossed a commit boundary.
        with closing(sqlite3.connect(self.database)) as connection:
            return connection.execute(f"SELECT * FROM {table}").fetchall()

    def test_swap_notice_auth_destinations_and_claim_survive_restart(self):
        address = self.serve()
        path = "/operator/deployment/swap-notice"
        payload = {
            "revision": TARGET,
            "attempt": "123456789",
            "from": "blue",
            "to": "green",
            "targets": [
                {"accountId": "T1", "channel": "U1"},
                {"accountId": "T1", "channel": "C1", "thread_ts": "12.34"},
                {"accountId": "T1", "channel": "C1", "thread_ts": "12.34"},
                {"accountId": "TOTHER", "channel": "COTHER"},
            ],
        }
        self.responder.send = Mock()
        raw = json.dumps(payload)
        self.assertEqual(self.request(address, "POST", path, raw)[0], 401)
        self.assertEqual(
            self.request(
                address,
                "POST",
                path,
                json.dumps({**payload, "from": "green"}),
                self.auth,
            )[0],
            400,
        )
        self.assertEqual(self.request(address, "POST", path, raw, self.auth)[0], 202)
        end = time.monotonic() + 2
        while self.responder.send.call_count < 2 and time.monotonic() < end:
            time.sleep(0.01)
        self.assertEqual(
            [call.args[0] for call in self.responder.send.call_args_list],
            [
                {
                    "channel": "U1",
                    "text": "swapping from blue to green for commit abc1234",
                    "unfurl_links": False,
                    "unfurl_media": False,
                },
                {
                    "channel": "C1",
                    "thread_ts": "12.34",
                    "text": "swapping from blue to green for commit abc1234",
                    "unfurl_links": False,
                    "unfurl_media": False,
                },
            ],
        )
        restarted = Responder(self.config, "/missing-marker", self.database)
        self.addCleanup(restarted.db.close)
        self.assertEqual(restarted.claim_swap(self.auth, payload), [])
        self.assertNotIn("C1", json.dumps(self.rows("handled")))

    def test_swap_notice_ack_does_not_wait_for_slack_and_unknown_send_is_not_retried(
        self,
    ):
        address = self.serve()
        path = "/operator/deployment/swap-notice"
        payload = {
            "revision": TARGET,
            "attempt": "2",
            "from": "green",
            "to": "blue",
            "targets": [{"accountId": "T1", "channel": "U1"}],
        }
        sending, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)

        def send(message):
            self.assertEqual(
                message["text"], "swapping from green to blue for commit abc1234"
            )
            sending.set()
            release.wait(3)
            raise TimeoutError("private Slack failure")

        self.responder.send = Mock(side_effect=send)
        host = Host.__new__(Host)
        host.config = {
            "blueGreen": {"intakeOrigin": f"http://{address[0]}:{address[1]}"}
        }
        host.intake_token = self.config["durableQueue"]["token"]
        host.swap_targets = payload["targets"]
        host.slot = lambda commit: "green" if commit == OLD else "blue"
        host.notify_swap(OLD, TARGET, 2)
        self.assertTrue(sending.wait(1))
        self.assertEqual(
            self.request(address, "POST", path, json.dumps(payload), self.auth)[0], 202
        )
        self.assertEqual(self.responder.send.call_count, 1)
        release.set()
        with patch.object(
            host, "request", side_effect=TimeoutError("private transport detail")
        ):
            host.notify_swap(OLD, TARGET, 2)  # Optional reporting cannot fence cutover.

    def test_authenticated_paused_commit_capacity_and_storage_failure(self):
        address = self.serve()
        self.assertEqual(self.request(address, "GET", CONTROL_PATH)[0], 401)
        self.assertEqual(
            self.request(
                address, "POST", CONTROL_PATH, "{}", {"authorization": "Bearer wrong"}
            )[0],
            401,
        )
        status, body = self.request(address, "GET", CONTROL_PATH, headers=self.auth)
        self.assertEqual(status, 200)
        self.assertEqual(
            json.loads(body),
            {"revision": None, "port": None, "paused": True, "settled": True},
        )
        for change in (
            {},
            {"revision": TARGET, "port": 9999, "paused": True},
            {"revision": TARGET, "port": 3081, "paused": 1},
            {"revision": TARGET[:7], "port": 3081, "paused": True},
            {"revision": TARGET, "port": 3081, "paused": True, "extra": 1},
            None,
        ):
            self.assertEqual(
                self.request(
                    address, "POST", CONTROL_PATH, json.dumps(change), self.auth
                )[0],
                400,
            )
        raw, headers = signed(event(1))
        self.assertEqual(
            self.request(address, "POST", "/webhooks/slack", raw + b" ", headers)[0],
            401,
        )
        self.assertEqual(self.responder.receive(*signed(event(1), age=301))[0], 401)
        self.assertEqual(self.rows("intake_queue"), [])
        self.assertEqual(
            self.request(address, "POST", "/webhooks/slack", raw, headers)[0], 200
        )
        self.assertEqual(self.rows("intake_queue")[0][1], raw)
        # Duplicate intake remains accepted even at capacity, including concurrent retries.
        with ThreadPoolExecutor(max_workers=8) as pool:
            self.assertEqual(
                list(
                    pool.map(
                        lambda _: self.responder.receive(raw, headers)[0], range(8)
                    )
                ),
                [200] * 8,
            )
        self.assertEqual(self.responder.receive(*signed(event(2)))[0], 200)
        self.assertEqual(self.responder.receive(*signed(event(3)))[0], 503)
        self.assertEqual(len(self.rows("intake_queue")), 2)
        self.responder.max_events = 3
        self.responder.max_bytes = 1
        self.assertEqual(self.responder.receive(*signed(event(3)))[0], 503)
        self.responder.max_bytes = 1024 * 1024
        with self.responder.condition, self.responder.db:
            self.responder.db.execute(
                "CREATE TRIGGER fail_commit BEFORE INSERT ON intake_queue BEGIN SELECT RAISE(ABORT, 'fixture'); END"
            )
        self.assertEqual(
            self.request(address, "POST", "/webhooks/slack", *signed(event(3)))[0], 503
        )
        self.assertEqual(len(self.rows("intake_queue")), 2)
        self.assertEqual(
            self.responder.receive(
                *signed({"type": "url_verification", "challenge": "fixture"})
            )[:2],
            (200, b"fixture"),
        )

    def test_interaction_identity_and_completed_only_retention(self):
        raw = urlencode(
            {
                "payload": json.dumps(
                    {"type": "block_actions", "team": {"id": "T1"}, "actions": []}
                )
            }
        ).encode()
        raw, headers = signed(raw)
        headers["content-type"] = "application/x-www-form-urlencoded; charset=utf-8"
        self.assertEqual(self.responder.receive(raw, headers)[0], 200)
        self.assertEqual(self.responder.receive(raw, headers)[0], 200)
        queued = self.rows("intake_queue")
        self.assertEqual(len(queued), 1)
        self.assertEqual(
            queued[0][:3],
            (hashlib.sha256(raw).hexdigest(), raw, headers["content-type"]),
        )
        with self.responder.db:
            self.responder.db.execute(
                "UPDATE intake_queue SET received_at='946684800000'"
            )
            self.responder.db.execute("INSERT INTO intake_receipts VALUES ('old',0)")
        self.assertEqual(self.responder.receive(*signed(event(1)))[0], 200)
        self.assertEqual(self.rows("intake_receipts"), [])
        self.assertEqual(len(self.rows("intake_queue")), 2)

    def test_restart_delayed_replay_lost_ack_and_inflight_pause(self):
        self.assertEqual(self.responder.receive(*signed(event(1)))[0], 200)
        arrival = "946684800000"
        with self.responder.db:
            self.responder.db.execute(
                "UPDATE intake_queue SET received_at=?", (arrival,)
            )
        # A previously verified route survives restart independently of a new probe.
        with self.responder.db:
            self.responder.db.execute(
                "UPDATE intake_route SET revision=?,port=3081,paused=0", (TARGET,)
            )
        self.responder.db.close()
        self.responder = Responder(self.config, "/missing-marker", self.database)
        self.assertFalse(
            json.loads(self.responder.intake_control(self.auth)[1])["paused"]
        )
        entered, finish, health_seen = (
            threading.Event(),
            threading.Event(),
            threading.Event(),
        )
        self.addCleanup(finish.set)
        calls = []
        health_revision = [OLD]
        reject_probe = [True]

        class App(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                body = json.dumps(
                    {"ready": True, "revision": health_revision[0]}
                ).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                health_seen.set()

            def do_POST(self):
                raw = self.rfile.read(int(self.headers["content-length"]))
                payload = json.loads(raw)
                if payload.get("type") == "url_verification":
                    body = payload["challenge"].encode()
                    self.send_response(401 if reject_probe[0] else 200)
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                    return
                calls.append((self.path, raw, dict(self.headers)))
                if len(calls) == 1:
                    # App persisted, but its ACK was lost: retry the identical envelope.
                    self.close_connection = True
                    return
                entered.set()
                finish.wait(5)
                self.send_response(200)
                self.send_header("Content-Length", "0")
                self.end_headers()

        app = ThreadingHTTPServer(("127.0.0.1", 0), App)
        app_thread = threading.Thread(target=app.serve_forever)
        app_thread.start()
        original = http.client.HTTPConnection

        def local_connection(host, port, **kwargs):
            return original(host, app.server_port if port == 3081 else port, **kwargs)

        try:
            with ExitStack() as stack:
                stack.enter_context(
                    patch(
                        "slack_responder.http.client.HTTPConnection",
                        side_effect=local_connection,
                    )
                )
                # Stop before restoring networking, even when an assertion fails.
                stack.callback(lambda: self.responder.stop())
                address = self.serve()
                self.assertTrue(health_seen.wait(2))
                self.assertEqual(calls, [])
                health_revision[0] = TARGET
                self.assertTrue(entered.wait(4))
                status, body = self.request(
                    address,
                    "POST",
                    CONTROL_PATH,
                    json.dumps({"revision": TARGET, "port": 3081, "paused": True}),
                    self.auth,
                )
                self.assertEqual(status, 200)
                self.assertEqual(
                    json.loads(body),
                    {
                        "revision": TARGET,
                        "port": 3081,
                        "paused": True,
                        "settled": False,
                    },
                )
                self.assertEqual(self.rows("intake_route")[0], (1, TARGET, 3081, 1))
                self.assertEqual(len(self.rows("intake_queue")), 1)
                self.assertEqual(self.responder.receive(*signed(event(2)))[0], 200)
                finish.set()
                deadline = time.monotonic() + 2
                while (
                    self.rows("intake_receipts") == [] and time.monotonic() < deadline
                ):
                    time.sleep(0.01)
                self.assertEqual(len(self.rows("intake_receipts")), 1)
                self.assertTrue(
                    json.loads(self.responder.intake_control(self.auth)[1])["settled"]
                )
                self.assertEqual(len(self.rows("intake_queue")), 1)
                self.assertEqual(self.responder.receive(*signed(event(1)))[0], 200)
                self.assertEqual(len(calls), 2)
                for path, raw, headers in calls:
                    self.assertEqual(path, "/operator/deployment/slack")
                    self.assertEqual(json.loads(raw), event(1))
                    self.assertEqual(headers["x-june-received-at"], arrival)
                    self.assertEqual(
                        headers["x-june-intake-token"],
                        self.config["durableQueue"]["token"],
                    )
                    stamp = headers["x-slack-request-timestamp"]
                    self.assertLess(abs(time.time() - int(stamp)), 5)
                    self.assertEqual(
                        headers["x-slack-signature"],
                        "v0="
                        + hmac.new(
                            b"fixture",
                            b"v0:" + stamp.encode() + b":" + raw,
                            hashlib.sha256,
                        ).hexdigest(),
                    )
                self.responder.stop()
                self.responder.db.close()
                self.responder = Responder(
                    self.config, "/missing-marker", self.database
                )
                self.assertEqual(self.responder.receive(*signed(event(1)))[0], 200)
                self.assertEqual(len(self.rows("intake_queue")), 1)
                self.assertEqual(len(self.rows("intake_receipts")), 1)
                # Healthy revision but broken replay credentials must not unpause.
                update = {"revision": TARGET, "port": 3081, "paused": False}
                self.assertEqual(
                    self.responder.intake_control(self.auth, update)[0], 503
                )
                self.assertEqual(self.rows("intake_route")[0], (1, TARGET, 3081, 1))
                reject_probe[0] = False
                self.assertEqual(
                    self.responder.intake_control(self.auth, update)[0], 200
                )
                self.assertEqual(self.rows("intake_route")[0], (1, TARGET, 3081, 0))
                self.assertEqual(len(self.rows("intake_queue")), 1)
        finally:
            finish.set()
            app.shutdown()
            app_thread.join()
            app.server_close()


if __name__ == "__main__":
    unittest.main()
