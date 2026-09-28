"""Safety boundaries and duplicate effects, using only disposable local state."""

import hashlib
import hmac
import http.client
import json
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from unittest.mock import Mock

from deploy import Deployer, Store
from slack_responder import Responder, Server

TARGET = "abc1234" + "9" * 33
OLD = "5" * 40
CONFIG = {
    "teamId": "T1",
    "botUserId": "UBOT",
    "signingSecret": "fixture",
    "botToken": "not-a-token",
}


def signed(payload, age=0):
    raw = json.dumps(payload).encode()
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


if __name__ == "__main__":
    unittest.main()
