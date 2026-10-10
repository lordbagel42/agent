"""Independent private Slack ingress. Install outside June's releases.

Legacy mode stores notice hashes only. Opt-in durable intake stores private raw
envelopes until app acceptance. Direct pings during an unblocked, paused cutover
also receive a deployment notice. Controller-requested swap notices are separate.
"""

import hashlib
import hmac
import http.client
import ipaddress
import json
import os
import re
import secrets
import sqlite3
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs

MAX_BODY = 1024 * 1024
SHA = re.compile(r"[0-9a-f]{40}")
ID = re.compile(r"[A-Z][A-Z0-9]{1,64}")
TS = re.compile(r"[0-9]{1,20}\.[0-9]{1,10}")
MESSAGE_SUBTYPES = (None, "file_share", "me_message", "thread_broadcast")
CONTROL_PATH = "/operator/deployment/intake"
SWAP_PATH = "/operator/deployment/swap-notice"
PAUSE_WAIT = 1.0
RECEIPT_LIMIT = 100_000


def matches(pattern, value):
    return isinstance(value, str) and pattern.fullmatch(value) is not None


class Responder:
    def __init__(self, config, marker, database):
        self.config, self.marker = config, Path(marker)
        address = ipaddress.IPv4Address(config.get("host", "127.0.0.1"))
        if not address.is_loopback and not any(
            address in ipaddress.IPv4Network(network)
            for network in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16")
        ):
            raise ValueError("invalid_responder_host")
        self.host = str(address)
        for key in ("teamId", "botUserId"):
            if not matches(ID, config.get(key)):
                raise ValueError("invalid_responder_config")
        for key in ("signingSecret", "botToken"):
            if not isinstance(config.get(key), str) or not config[key]:
                raise ValueError("invalid_responder_config")
        self.queue = config.get("durableQueue")
        if "durableQueue" in config:
            if not isinstance(self.queue, dict):
                raise ValueError("invalid_durable_queue")
            token = self.queue.get("token")
            if (
                not isinstance(token, str)
                or not 32 <= len(token) <= 512
                or not re.fullmatch(r"[!-~]+", token)
                or token in (config["signingSecret"], config["botToken"])
            ):
                raise ValueError("invalid_intake_token")
            for key, default, maximum in (
                ("maxBytes", 64 * MAX_BODY, 1024 * MAX_BODY),
                ("maxEvents", 10_000, 100_000),
            ):
                value = self.queue.get(key, default)
                if type(value) is not int or not 1 <= value <= maximum:
                    raise ValueError("invalid_queue_capacity")
            self.max_bytes = self.queue.get("maxBytes", 64 * MAX_BODY)
            self.max_events = self.queue.get("maxEvents", 10_000)
        self.lock = threading.Lock()
        self.condition = threading.Condition(self.lock)
        self.stopping = threading.Event()
        self.worker = None
        self.inflight = False
        self.control_epoch = 0
        if self.queue is not None:
            fd = os.open(database, os.O_CREAT | os.O_RDWR, 0o600)
            os.fchmod(fd, 0o600)
            os.close(fd)
        self.db = sqlite3.connect(database, check_same_thread=False)
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS handled (id TEXT PRIMARY KEY, at INTEGER NOT NULL)"
        )
        if self.queue is not None:
            self.db.execute("PRAGMA secure_delete=ON")
            with self.db:
                self.db.execute(
                    "CREATE TABLE IF NOT EXISTS intake_queue ("
                    "id TEXT PRIMARY KEY, raw BLOB NOT NULL, content_type TEXT NOT NULL, "
                    "received_at TEXT NOT NULL)"
                )
                self.db.execute(
                    "CREATE TABLE IF NOT EXISTS intake_receipts ("
                    "id TEXT PRIMARY KEY, at INTEGER NOT NULL)"
                )
                self.db.execute(
                    "CREATE INDEX IF NOT EXISTS intake_receipts_at ON intake_receipts(at)"
                )
                self.db.execute(
                    "CREATE TABLE IF NOT EXISTS intake_route ("
                    "id INTEGER PRIMARY KEY CHECK(id=1), revision TEXT, port INTEGER, "
                    "paused INTEGER NOT NULL)"
                )
                self.db.execute(
                    "INSERT OR IGNORE INTO intake_route VALUES (1,NULL,NULL,1)"
                )

    def intake_authorized(self, headers):
        return self.queue is not None and hmac.compare_digest(
            headers.get("authorization", "").encode(),
            f"Bearer {self.queue['token']}".encode(),
        )

    def route_locked(self):
        revision, port, paused = self.db.execute(
            "SELECT revision,port,paused FROM intake_route WHERE id=1"
        ).fetchone()
        return {
            "revision": revision,
            "port": port,
            "paused": bool(paused),
            "settled": not self.inflight,
        }

    def intake_control(self, headers, update=None):
        if not self.intake_authorized(headers):
            return 401, b"", "text/plain"
        if update is not None and (
            not isinstance(update, dict)
            or set(update) != {"revision", "port", "paused"}
            or not matches(SHA, update.get("revision"))
            or type(update.get("port")) is not int
            or update["port"] not in (3081, 3082)
            or type(update.get("paused")) is not bool
        ):
            return 400, b"", "text/plain"
        if update is not None:
            with self.condition:
                self.control_epoch += 1
                epoch = self.control_epoch
            if not update["paused"]:
                # Exercise the actual private replay route, signing secret and
                # credential without publishing a conversation event. A healthy
                # app alone does not prove this broker can deliver to it.
                challenge = f"june-intake:{update['revision']}:{secrets.token_hex(16)}"
                raw = json.dumps(
                    {
                        "type": "url_verification",
                        "team_id": self.config["teamId"],
                        "challenge": challenge,
                    }
                ).encode()
                item = (None, raw, "application/json", str(int(time.time() * 1000)))
                try:
                    if not self.deliver(update, item, challenge=challenge):
                        return 503, b"", "text/plain"
                except Exception:  # noqa: BLE001 - no credentials or probe details
                    return 503, b"", "text/plain"
        with self.condition:
            if update is not None:
                if epoch != self.control_epoch:
                    return 409, b"", "text/plain"
                with self.db:
                    self.db.execute(
                        "UPDATE intake_route SET revision=?,port=?,paused=? WHERE id=1",
                        (update["revision"], update["port"], int(update["paused"])),
                    )
                self.condition.notify_all()
                if update["paused"]:
                    # A timeout is explicitly NOT evidence of settlement.
                    self.condition.wait_for(lambda: not self.inflight, PAUSE_WAIT)
            state = self.route_locked()
        return 200, json.dumps(state).encode(), "application/json"

    def enqueue(self, identity, raw, content_type):
        with self.condition, self.db:
            now = int(time.time())
            self.db.execute("DELETE FROM intake_receipts WHERE at < ?", (now - 172800,))
            if self.db.execute(
                "SELECT 1 FROM intake_queue WHERE id=? UNION ALL "
                "SELECT 1 FROM intake_receipts WHERE id=?",
                (identity, identity),
            ).fetchone():
                return 200, b"", "text/plain"
            count, size = self.db.execute(
                "SELECT COUNT(*),COALESCE(SUM(length(raw)+length(content_type)),0) "
                "FROM intake_queue"
            ).fetchone()
            if (
                count >= self.max_events
                or size + len(raw) + len(content_type) > self.max_bytes
            ):
                return 503, b"", "text/plain"
            self.db.execute(
                "INSERT INTO intake_queue VALUES (?,?,?,?)",
                (
                    identity,
                    raw,
                    content_type,
                    str(int(time.time() * 1000)),
                ),
            )
            self.condition.notify_all()
        # Exiting the SQLite transaction (including fsync) precedes acceptance.
        return 200, b"", "text/plain"

    def deliver(self, route, item, *, challenge=None):
        _, raw, content_type, received_at = item
        connection = http.client.HTTPConnection("127.0.0.1", route["port"], timeout=2)
        try:
            connection.request("GET", "/health")
            response = connection.getresponse()
            body = response.read(MAX_BODY + 1)
            if response.status != 200 or len(body) > MAX_BODY:
                return False
            health = json.loads(body)
            if (
                not isinstance(health, dict)
                or health.get("ready") is not True
                or health.get("revision") != route["revision"]
            ):
                return False
            # A pause arriving during health inspection must fence the POST too.
            if challenge is None:
                with self.condition:
                    current = self.route_locked()
                    if (
                        self.stopping.is_set()
                        or current["paused"]
                        or any(
                            current[key] != route[key] for key in ("revision", "port")
                        )
                    ):
                        return False
            stamp = str(int(time.time()))
            signature = hmac.new(
                self.config["signingSecret"].encode(),
                b"v0:" + stamp.encode() + b":" + raw,
                hashlib.sha256,
            ).hexdigest()
            connection.request(
                "POST",
                "/operator/deployment/slack",
                raw,
                {
                    "content-type": content_type,
                    "x-slack-request-timestamp": stamp,
                    "x-slack-signature": "v0=" + signature,
                    "x-june-intake-token": self.queue["token"],
                    "x-june-received-at": received_at,
                    "x-june-revision": route["revision"],
                },
            )
            response = connection.getresponse()
            body = response.read(MAX_BODY + 1)
            if challenge is not None:
                return response.status == 200 and body == challenge.encode()
            return 200 <= response.status < 300 and len(body) <= MAX_BODY
        finally:
            connection.close()

    def run_queue(self):
        while not self.stopping.is_set():
            delivered = False
            try:
                with self.condition:
                    route = self.route_locked()
                    item = (
                        None
                        if route["paused"]
                        else self.db.execute(
                            "SELECT id,raw,content_type,received_at FROM intake_queue ORDER BY rowid LIMIT 1"
                        ).fetchone()
                    )
                    if item is None:
                        self.condition.wait(1)
                        continue
                    self.inflight = True
                if self.deliver(route, item):
                    with self.condition, self.db:
                        self.db.execute(
                            "INSERT OR REPLACE INTO intake_receipts VALUES (?,?)",
                            (item[0], int(time.time())),
                        )
                        self.db.execute(
                            "DELETE FROM intake_queue WHERE id=?", (item[0],)
                        )
                        # Never prune pending payloads, even when old or poison.
                        self.db.execute(
                            "DELETE FROM intake_receipts WHERE at < ?",
                            (int(time.time()) - 172800,),
                        )
                        self.db.execute(
                            "DELETE FROM intake_receipts WHERE id IN (SELECT id FROM intake_receipts ORDER BY at DESC, rowid DESC LIMIT -1 OFFSET ?)",
                            (RECEIPT_LIMIT,),
                        )
                    delivered = True
            except Exception:  # noqa: BLE001 - retain payload on all uncertain ACK/storage failures
                print("slack_intake_delivery_unconfirmed", flush=True)
            finally:
                with self.condition:
                    self.inflight = False
                    self.condition.notify_all()
            if not delivered:
                self.stopping.wait(1)

    def start(self):
        if self.queue is not None and self.worker is None:
            self.worker = threading.Thread(target=self.run_queue, name="slack-intake")
            self.worker.start()

    def stop(self):
        self.stopping.set()
        with self.condition:
            self.condition.notify_all()
        if self.worker is not None:
            self.worker.join()

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

    def claim_swap(self, headers, update):
        """Claim before ACK/send. Unknown outcomes are never retried.

        Only fixed text and validated same-account transport IDs are accepted;
        the controller cannot turn this into an arbitrary messaging endpoint.
        """
        if not self.intake_authorized(headers):
            return 401, b"", "text/plain"
        if (
            not isinstance(update, dict)
            or set(update) != {"revision", "attempt", "from", "to", "targets"}
            or not matches(SHA, update.get("revision"))
            or not isinstance(update.get("attempt"), str)
            or not re.fullmatch(r"[0-9]{1,24}", update["attempt"])
            or (update.get("from"), update.get("to"))
            not in (("blue", "green"), ("green", "blue"))
            or not isinstance(update.get("targets"), list)
            or len(update["targets"]) > 100
        ):
            return 400, b"", "text/plain"
        for target in update["targets"]:
            if (
                not isinstance(target, dict)
                or set(target)
                not in ({"accountId", "channel"}, {"accountId", "channel", "thread_ts"})
                or not matches(ID, target.get("accountId"))
                or not matches(ID, target.get("channel"))
                or ("thread_ts" in target and not matches(TS, target["thread_ts"]))
            ):
                return 400, b"", "text/plain"
        notices = []
        text = f"swapping from {update['from']} to {update['to']} for commit {update['revision'][:7]}"
        for target in update["targets"]:
            if target["accountId"] != self.config["teamId"]:
                continue
            key = hashlib.sha256(
                json.dumps(
                    [
                        "swap",
                        update["revision"],
                        update["attempt"],
                        update["from"],
                        update["to"],
                        target,
                    ],
                    sort_keys=True,
                ).encode()
            ).hexdigest()
            if not self.handled([key], claim=True):
                notices.append(
                    {
                        "channel": target["channel"],
                        **(
                            {"thread_ts": target["thread_ts"]}
                            if "thread_ts" in target
                            else {}
                        ),
                        "text": text,
                        "unfurl_links": False,
                        "unfurl_media": False,
                    }
                )
        return notices

    def forward(self, raw, headers):
        connection = http.client.HTTPConnection(
            self.host, self.config.get("upstreamPort", 3080), timeout=2
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
        if not 0 < len(raw) <= MAX_BODY:
            return 413, b"", "text/plain"
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
        if self.queue is not None:
            content_type = headers.get("content-type", "application/json")
            if (
                len(content_type) > 256
                or not content_type.isascii()
                or "\r" in content_type
                or "\n" in content_type
            ):
                return 400, b"", "text/plain"
            if keys:
                # Keep callback identities distinct; the app owns message dedup.
                identity = hashlib.sha256(json.dumps(keys[0]).encode()).hexdigest()
            elif content_type.startswith("application/x-www-form-urlencoded"):
                values = parse_qs(raw.decode(), max_num_fields=8)
                if len(values.get("payload", [])) != 1:
                    return 400, b"", "text/plain"
                interaction = json.loads(values["payload"][0])
                if not isinstance(interaction, dict):
                    return 400, b"", "text/plain"
                team = interaction.get("team")
                if (
                    not isinstance(team, dict)
                    or team.get("id") != self.config["teamId"]
                ):
                    return 403, b"", "text/plain"
                identity = hashlib.sha256(raw).hexdigest()
            else:
                return 400, b"", "text/plain"
            accepted = self.enqueue(identity, raw, content_type)
            if accepted[0] != 200:
                return accepted
            with self.lock:
                paused = self.route_locked()["paused"]
            if not paused:
                return accepted
            try:
                return self.deployment_response(raw, headers, payload, keys)
            except Exception:  # noqa: BLE001 - notice failure must not undo durable acceptance
                print("slack_deploy_notice_unavailable", flush=True)
                return accepted
        return self.deployment_response(raw, headers, payload, keys)

    def deployment_response(self, raw, headers, payload, keys):
        # Notice claims are independent of intake identities: a notice must
        # never consume or suppress the queued conversation's eventual replay.
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
            return (
                (200, b"", "text/plain")
                if self.queue is not None
                else self.forward(raw, headers)
            )
        # An unresolved activation is not proof a deployment is progressing.
        # Keep legacy admission fenced; durable intake already retained input.
        if marker["blocked"]:
            return (200 if self.queue is not None else 503), b"", "text/plain"
        if keys and self.handled(keys, claim=True):
            return 200, b"", "text/plain"
        if payload.get("type") != "event_callback":
            return 200, b"", "text/plain"
        event = payload["event"]
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

    def reply(self, status, body, kind):
        self.send_response(status)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)
        self.wfile.flush()

    def do_GET(self):
        result = (404, b"", "text/plain")
        try:
            if self.path == CONTROL_PATH and self.server.responder.queue is not None:
                result = self.server.responder.intake_control(self.headers)
        except Exception:  # noqa: BLE001 - no private state in logs
            result = (503, b"", "text/plain")
        self.reply(*result)

    def do_POST(self):
        status, body, kind = 503, b"", "text/plain"
        notices = []
        swap = self.path == SWAP_PATH and self.server.responder.queue is not None
        control = (
            self.path in (CONTROL_PATH, SWAP_PATH)
            and self.server.responder.queue is not None
        )
        try:
            if self.path != "/webhooks/slack" and not control:
                status = 404
            elif control and not self.server.responder.intake_authorized(self.headers):
                status = 401
            elif (
                self.headers.get("transfer-encoding")
                or len(self.headers.get_all("content-length", [])) != 1
            ) or not self.headers["content-length"].isdigit():
                status = 400
            elif (
                not 0
                < int(self.headers["content-length"])
                <= (32768 if swap else 4096 if control else MAX_BODY)
            ):
                status = 413
            else:
                raw = self.rfile.read(int(self.headers["content-length"]))
                if len(raw) != int(self.headers["content-length"]):
                    status = 400
                else:
                    if swap:
                        result = self.server.responder.claim_swap(
                            self.headers, json.loads(raw)
                        )
                    elif control:
                        update = json.loads(raw)
                        result = (
                            self.server.responder.intake_control(self.headers, update)
                            if isinstance(update, dict)
                            else (400, b"", "text/plain")
                        )
                    else:
                        result = self.server.responder.receive(raw, self.headers)
                    if isinstance(result, list):
                        notices = result
                        status, body, kind = (
                            202,
                            b'{"accepted":true}',
                            "application/json",
                        )
                    elif isinstance(result, dict):
                        notices = [result]
                        status = 200
                    else:
                        status, body, kind = result
        except (json.JSONDecodeError, UnicodeDecodeError):
            status = 400
        except Exception:  # noqa: BLE001 - fail closed without private request logs
            print("slack_responder_unavailable", flush=True)
        self.reply(status, body, kind)
        for notice in notices:
            try:
                self.server.responder.send(notice)
            except Exception:  # noqa: BLE001 - never retry or log private Slack errors
                print("slack_deploy_notice_not_confirmed", flush=True)


class Server(ThreadingHTTPServer):
    daemon_threads = False

    def __init__(self, port, responder):
        self.responder = responder
        self.slots = threading.BoundedSemaphore(32)
        super().__init__((responder.host, port), Handler)
        responder.start()

    def server_close(self):
        self.responder.stop()
        super().server_close()

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
    default_port = 3083 if "durableQueue" in config else 3081
    for key, default in (("port", default_port), ("upstreamPort", 3080)):
        if (
            type(config.get(key, default)) is not int
            or not 1024 <= config.get(key, default) <= 65535
        ):
            raise ValueError("invalid_responder_port")
    if config.get("port", default_port) == config.get("upstreamPort", 3080) or (
        "durableQueue" in config and config.get("port", default_port) in (3081, 3082)
    ):
        raise ValueError("responder_proxy_loop")
    responder = Responder(
        config,
        "/var/lib/june-deploy/public/slack-responder.json",
        "/var/lib/june-slack-responder/handled.sqlite",
    )
    try:
        with Server(config.get("port", default_port), responder) as server:
            server.serve_forever()
    finally:
        responder.db.close()


if __name__ == "__main__":
    try:
        main()
    except Exception:  # noqa: BLE001 - startup errors must not disclose credentials
        print("slack_responder_start_failed", file=sys.stderr)
        sys.exit(1)
