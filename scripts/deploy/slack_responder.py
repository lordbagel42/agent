"""Independent, loopback-only Slack ingress. Install outside June's releases.

No model, message queue, or send retry. Only hashes of handled events persist.
The controller's explicit intent, not upstream failure, enables deploy notices.
"""

import hashlib
import hmac
import http.client
import json
import os
import re
import sqlite3
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

MAX_BODY = 1024 * 1024
SHA = re.compile(r"[0-9a-f]{40}")
ID = re.compile(r"[A-Z][A-Z0-9]{1,64}")
TS = re.compile(r"[0-9]{1,20}\.[0-9]{1,10}")
MESSAGE_SUBTYPES = (None, "file_share", "me_message", "thread_broadcast")


def matches(pattern, value):
    return isinstance(value, str) and pattern.fullmatch(value) is not None


class Responder:
    def __init__(self, config, marker, database):
        self.config, self.marker = config, Path(marker)
        for key in ("teamId", "botUserId"):
            if not matches(ID, config.get(key)):
                raise ValueError("invalid_responder_config")
        for key in ("signingSecret", "botToken"):
            if not isinstance(config.get(key), str) or not config[key]:
                raise ValueError("invalid_responder_config")
        self.lock = threading.Lock()
        self.db = sqlite3.connect(database, check_same_thread=False)
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS handled (id TEXT PRIMARY KEY, at INTEGER NOT NULL)"
        )

    def handled(self, keys, claim=False):
        with self.lock, self.db:
            now = int(time.time())
            self.db.execute("DELETE FROM handled WHERE at < ?", (now - 172800,))
            if any(
                self.db.execute("SELECT 1 FROM handled WHERE id=?", (key,)).fetchone()
                for key in keys
            ):
                return True
            if claim:
                if (
                    self.db.execute("SELECT COUNT(*) FROM handled").fetchone()[0]
                    + len(keys)
                    > 100_000
                ):
                    raise ValueError("responder_capacity")
                self.db.executemany(
                    "INSERT INTO handled VALUES (?,?)", [(key, now) for key in keys]
                )
            return False

    def forward(self, raw, headers):
        connection = http.client.HTTPConnection(
            "127.0.0.1", self.config.get("upstreamPort", 3080), timeout=2
        )
        try:
            connection.request(
                "POST",
                "/webhooks/slack",
                raw,
                {
                    name: headers[name]
                    for name in (
                        "content-type",
                        "x-slack-signature",
                        "x-slack-request-timestamp",
                        "x-slack-retry-num",
                        "x-slack-retry-reason",
                    )
                    if headers.get(name) is not None
                },
            )
            response = connection.getresponse()
            body = response.read(MAX_BODY + 1)
            if len(body) > MAX_BODY:
                raise ValueError("upstream_body_limit")
            return (
                response.status,
                body,
                response.getheader("content-type", "text/plain"),
            )
        finally:
            connection.close()

    def send(self, message):
        connection = http.client.HTTPSConnection("slack.com", timeout=1.5)
        try:
            connection.request(
                "POST",
                "/api/chat.postMessage",
                json.dumps(message),
                {
                    "authorization": f"Bearer {self.config['botToken']}",
                    "content-type": "application/json; charset=utf-8",
                },
            )
            response = connection.getresponse()
            result = json.loads(response.read(MAX_BODY))
            if (
                response.status != 200
                or not isinstance(result, dict)
                or result.get("ok") is not True
            ):
                raise ValueError("notice_not_confirmed")
        finally:
            connection.close()

    def receive(self, raw, headers):
        """Return an HTTP response or a durably claimed notice to send after ACK."""
        stamp = headers.get("x-slack-request-timestamp", "")
        if (
            not re.fullmatch(r"[0-9]{1,12}", stamp)
            or abs(time.time() - int(stamp)) > 300
        ):
            return 401, b"", "text/plain"
        expected = (
            "v0="
            + hmac.new(
                self.config["signingSecret"].encode(),
                b"v0:" + stamp.encode() + b":" + raw,
                hashlib.sha256,
            ).hexdigest()
        )
        signature = headers.get("x-slack-signature", "")
        if not re.fullmatch(r"v0=[0-9a-f]{64}", signature) or not hmac.compare_digest(
            expected, signature
        ):
            return 401, b"", "text/plain"
        # Form-encoded interactive requests still pass through normally; they
        # are never an authorization to send a downtime message.
        payload = (
            {}
            if headers.get("content-type", "").startswith(
                "application/x-www-form-urlencoded"
            )
            else json.loads(raw)
        )
        if not isinstance(payload, dict):
            return 400, b"", "text/plain"
        if payload.get("team_id", self.config["teamId"]) != self.config["teamId"]:
            return 403, b"", "text/plain"
        if payload.get("type") == "url_verification":
            challenge = payload.get("challenge")
            return (
                (200, challenge.encode(), "text/plain")
                if isinstance(challenge, str)
                else (400, b"", "text/plain")
            )
        keys = []
        event = payload.get("event")
        if payload.get("type") == "event_callback":
            if payload.get("team_id") != self.config["teamId"]:
                return 403, b"", "text/plain"
            if (
                not isinstance(event, dict)
                or not isinstance(payload.get("event_id"), str)
                or not payload["event_id"]
            ):
                return 400, b"", "text/plain"
            keys.append(["event", payload["team_id"], payload["event_id"]])
            # message + app_mention can describe the same Slack message.
            if (
                event.get("type") in ("message", "app_mention")
                and event.get("subtype") in MESSAGE_SUBTYPES
                and matches(ID, event.get("channel"))
                and matches(TS, event.get("ts"))
            ):
                keys.append(
                    ["message", payload["team_id"], event["channel"], event["ts"]]
                )
        keys = [hashlib.sha256(json.dumps(key).encode()).hexdigest() for key in keys]
        if keys and self.handled(keys):
            return 200, b"", "text/plain"
        try:
            with self.marker.open("rb") as file:
                marker = json.loads(file.read(4096))
        except (json.JSONDecodeError, UnicodeDecodeError) as error:
            raise ValueError("invalid_responder_marker") from error
        if (
            not isinstance(marker, dict)
            or marker.get("version") != 1
            or type(marker.get("blocked")) is not bool
            or "revision" not in marker
        ):
            raise ValueError("invalid_responder_marker")
        revision = marker["revision"]
        if revision is not None and not matches(SHA, revision):
            raise ValueError("invalid_responder_revision")
        if revision is None:
            return self.forward(raw, headers)
        # An unresolved activation is not proof a deployment is progressing.
        # Keep admission fenced without fabricating a deploying notice.
        if marker["blocked"]:
            return 503, b"", "text/plain"
        if keys and self.handled(keys, claim=True):
            return 200, b"", "text/plain"
        if payload.get("type") != "event_callback":
            return 200, b"", "text/plain"
        text = event.get("text", "")
        direct = event.get("type") == "message" and event.get("channel_type") == "im"
        mentioned = isinstance(text, str) and f"<@{self.config['botUserId']}>" in text
        if (
            event.get("type") not in ("message", "app_mention")
            or event.get("subtype") not in MESSAGE_SUBTYPES
            or event.get("hidden")
            or event.get("bot_id")
            or event.get("app_id")
            or not matches(ID, event.get("user"))
            or event["user"] == self.config["botUserId"]
            or not matches(ID, event.get("channel"))
            or not matches(TS, event.get("ts"))
            or (
                event.get("thread_ts") is not None
                and not matches(TS, event["thread_ts"])
            )
            or not (direct or mentioned)
        ):
            return 200, b"", "text/plain"
        message = {
            "channel": event["channel"],
            "text": f"currently deploying <https://github.com/lordbagel42/agent/commit/{revision}|{revision[:7]}>",
            "unfurl_links": False,
            "unfurl_media": False,
        }
        if event.get("thread_ts") or not direct:
            message["thread_ts"] = event.get("thread_ts") or event["ts"]
        return message


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def setup(self):
        super().setup()
        self.connection.settimeout(3)

    def do_POST(self):
        status, body, kind = 503, b"", "text/plain"
        notice = None
        try:
            if self.path != "/webhooks/slack":
                status = 404
            elif (
                self.headers.get("transfer-encoding")
                or len(self.headers.get_all("content-length", [])) != 1
            ) or not self.headers["content-length"].isdigit():
                status = 400
            elif not 0 < int(self.headers["content-length"]) <= MAX_BODY:
                status = 413
            else:
                raw = self.rfile.read(int(self.headers["content-length"]))
                if len(raw) != int(self.headers["content-length"]):
                    status = 400
                else:
                    result = self.server.responder.receive(raw, self.headers)
                    if isinstance(result, dict):
                        notice = result
                        status = 200
                    else:
                        status, body, kind = result
        except (json.JSONDecodeError, UnicodeDecodeError):
            status = 400
        except Exception:  # noqa: BLE001 - fail closed without private request logs
            print("slack_responder_unavailable", flush=True)
        self.send_response(status)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)
        self.wfile.flush()
        if notice is not None:
            try:
                self.server.responder.send(notice)
            except Exception:  # noqa: BLE001 - never retry or log private Slack errors
                print("slack_deploy_notice_not_confirmed", flush=True)


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, port, responder):
        self.responder = responder
        self.slots = threading.BoundedSemaphore(32)
        super().__init__(("127.0.0.1", port), Handler)

    def process_request(self, request, address):
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, address)
        except Exception:
            self.slots.release()
            raise

    def process_request_thread(self, request, address):
        try:
            super().process_request_thread(request, address)
        finally:
            self.slots.release()

    def handle_error(self, request, address):
        print("slack_responder_request_failed", flush=True)


def main():
    config = json.loads(
        (Path(os.environ["CREDENTIALS_DIRECTORY"]) / "config").read_text()
    )
    for key, default in (("port", 3081), ("upstreamPort", 3080)):
        if (
            type(config.get(key, default)) is not int
            or not 1024 <= config.get(key, default) <= 65535
        ):
            raise ValueError("invalid_responder_port")
    if config.get("port", 3081) == config.get("upstreamPort", 3080):
        raise ValueError("responder_proxy_loop")
    responder = Responder(
        config,
        "/var/lib/june-deploy/public/slack-responder.json",
        "/var/lib/june-slack-responder/handled.sqlite",
    )
    with Server(config.get("port", 3081), responder) as server:
        server.serve_forever()


if __name__ == "__main__":
    try:
        main()
    except Exception:  # noqa: BLE001 - startup errors must not disclose credentials
        print("slack_responder_start_failed", file=sys.stderr)
        sys.exit(1)
