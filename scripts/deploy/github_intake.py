"""Independent GitHub webhook inbox. No deployment authority or App signing key.

Persist authenticated deliveries before ACK, forward to June with original
identities, and wake the controller. Its normal trusted-main fetch still owns
admission; receipt of a webhook does not mean a revision is queued to deploy.
"""

import hashlib
import hmac
import http.client
import json
import os
import re
import socket
import sqlite3
import stat
import threading
import time
from contextlib import closing, contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

MAX_BODY = 25 * 1024 * 1024
MAX_PENDING_BYTES = 100 * 1024 * 1024
MAX_DELIVERIES = 100_000
WAKE_SOCKET = "/var/lib/june-deploy/github-wake.sock"
CONTROLLER_DB = "/var/lib/june-deploy/records/deploy.sqlite"
REQUEST_SECONDS = 10


def wake_controller():
    # Do not wake a fenced controller, and never start one. The controller also
    # rechecks fences, so a race after this read cannot authorize activation.
    try:
        with closing(
            sqlite3.connect(f"file:{CONTROLLER_DB}?mode=ro", uri=True, timeout=0.1)
        ) as db:
            if db.execute(
                "SELECT 1 FROM state WHERE key IN ('blocked','recovery','operatorHold') AND value!='' LIMIT 1"
            ).fetchone():
                return
        with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as wake:
            wake.setblocking(False)
            wake.sendto(b"github", WAKE_SOCKET)
    except (OSError, sqlite3.Error):
        return  # Unavailable controller/state: keep polling as reconciliation.


def active_origin():
    current = Path("/opt/june/current").resolve(strict=True)
    if current.parent != Path("/opt/june/releases") or not re.fullmatch(
        r"[0-9a-f]{40}", current.name
    ):
        raise ValueError("unknown_active_release")
    for port in (3081, 3082):
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        try:
            connection.request("GET", "/health")
            response = connection.getresponse()
            body = response.read(8193)
            if response.status != 200 or len(body) > 8192:
                continue
            health = json.loads(body)
            if health.get("ready") is True and health.get("revision") == current.name:
                return f"http://127.0.0.1:{port}"
        except (OSError, ValueError, http.client.HTTPException):
            continue
        finally:
            connection.close()
    raise ValueError("active_release_not_ready")


def private_json(path):
    with open(
        path, opener=lambda name, flags: os.open(name, flags | os.O_NOFOLLOW)
    ) as file:
        meta = os.fstat(file.fileno())
        if meta.st_uid != 0 or meta.st_mode & 0o077 or not stat.S_ISREG(meta.st_mode):
            raise ValueError("private_root_file_required")
        return json.load(file)


class Inbox:
    def __init__(self, database, secret, installation):
        if not isinstance(secret, str) or len(secret) < 32:
            raise ValueError("invalid_webhook_secret")
        if type(installation) is not int or installation <= 0:
            raise ValueError("invalid_installation")
        self.database, self.secret, self.installation = (
            database,
            secret.encode(),
            installation,
        )
        with self.connect() as db:
            db.executescript("""
                PRAGMA journal_mode=WAL;
                PRAGMA secure_delete=ON;
                CREATE TABLE IF NOT EXISTS deliveries(
                    id TEXT PRIMARY KEY, digest TEXT NOT NULL, event TEXT NOT NULL,
                    signature TEXT NOT NULL, body BLOB, received INTEGER NOT NULL);
            """)

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.database, timeout=5)
        try:
            db.execute("PRAGMA synchronous=FULL")
            db.execute("PRAGMA secure_delete=ON")
            with db:
                yield db
        finally:
            db.close()

    def receive(self, delivery, event, signature, body):
        if len(body) > MAX_BODY:
            return 413
        expected = "sha256=" + hmac.new(self.secret, body, hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected.encode(), signature.encode()):
            return 401
        if not re.fullmatch(r"[A-Za-z0-9-]{1,256}", delivery) or not re.fullmatch(
            r"[a-z][a-z0-9_]{0,99}", event
        ):
            return 400
        try:
            payload = json.loads(body)
            if not isinstance(payload, dict):
                return 400
        except (ValueError, UnicodeError):
            return 400
        # Event/delivery headers aren't covered by HMAC. They are routing hints,
        # never authority. Even valid hints only cause a trusted Git fetch.
        repository = payload.get("repository")
        installation = payload.get("installation")
        relevant = (
            isinstance(repository, dict)
            and repository.get("full_name") == "lordbagel42/agent"
            and isinstance(installation, dict)
            and installation.get("id") == self.installation
            and (
                event == "push"
                and payload.get("ref") == "refs/heads/main"
                and payload.get("deleted") is False
                or event == "workflow_run"
                and isinstance(payload.get("workflow_run"), dict)
                and payload["workflow_run"].get("head_branch") == "main"
                and payload["workflow_run"].get("event") == "push"
            )
        )
        digest = hashlib.sha256(event.encode() + b"\0" + body).hexdigest()
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            prior = db.execute(
                "SELECT digest FROM deliveries WHERE id=?", (delivery,)
            ).fetchone()
            if prior:
                return 202 if prior[0] == digest else 409
            db.execute(
                "DELETE FROM deliveries WHERE body IS NULL AND received<?",
                (int(time.time()) - 7 * 86400,),
            )
            count, size = db.execute(
                "SELECT COUNT(*), COALESCE(SUM(LENGTH(body)),0) FROM deliveries"
            ).fetchone()
            if count >= MAX_DELIVERIES or size + len(body) > MAX_PENDING_BYTES:
                return 503
            db.execute(
                "INSERT INTO deliveries VALUES (?,?,?,?,?,?)",
                (delivery, digest, event, signature, body, int(time.time())),
            )
        if relevant:
            # Lost/coalesced wakes are harmless: polling remains authoritative.
            wake_controller()
        return 202

    def forward_one(self, origin):
        with self.connect() as db:
            row = db.execute(
                "SELECT id,event,signature,body FROM deliveries WHERE body IS NOT NULL ORDER BY received,id LIMIT 1"
            ).fetchone()
        if not row:
            return False
        if origin == "active-slot":
            origin = active_origin()
        target = urlsplit(origin)
        connection = http.client.HTTPConnection(
            target.hostname, target.port, timeout=10
        )
        try:
            connection.request(
                "POST",
                "/webhooks/github",
                row[3],
                {
                    "Content-Type": "application/json",
                    "X-GitHub-Delivery": row[0],
                    "X-GitHub-Event": row[1],
                    "X-Hub-Signature-256": row[2],
                },
            )
            response = connection.getresponse()
            body = response.read(8193)
            if (
                response.status != 202
                or len(body) > 8192
                or json.loads(body).get("accepted") is not True
            ):
                return False
            with self.connect() as db:
                db.execute("UPDATE deliveries SET body=NULL WHERE id=?", (row[0],))
                # Retain only replay identity once June durably accepts the event.
            return True
        finally:
            connection.close()


class Server(ThreadingHTTPServer):
    def __init__(self, *args):
        self.capacity = threading.BoundedSemaphore(8)
        super().__init__(*args)

    def process_request(self, request, address):
        if not self.capacity.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, address)
        except Exception:
            self.capacity.release()
            raise

    def process_request_thread(self, request, address):
        try:
            super().process_request_thread(request, address)
        finally:
            self.capacity.release()

    def handle_error(self, *_args):
        pass  # Peer timeout/disconnect; never print private request exceptions.


class Handler(BaseHTTPRequestHandler):
    def setup(self):
        self.request.settimeout(REQUEST_SECONDS)
        self.deadline = threading.Timer(REQUEST_SECONDS, self.expire)
        self.deadline.daemon = True
        self.deadline.start()
        super().setup()

    def expire(self):
        try:
            self.request.shutdown(socket.SHUT_RDWR)
        except OSError:
            return

    def finish(self):
        self.deadline.cancel()
        super().finish()

    def log_message(self, *_args):
        pass  # Never log signed payloads, headers or provider paths.

    def do_POST(self):
        self.connection.settimeout(10)
        if self.path != "/webhooks/github":
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length", "-1"))
            if self.headers.get("Transfer-Encoding") or not 0 <= length <= MAX_BODY:
                status = 413
            else:
                body = self.rfile.read(length)
                status = (
                    400
                    if len(body) != length
                    else self.server.inbox.receive(
                        self.headers.get("X-GitHub-Delivery", ""),
                        self.headers.get("X-GitHub-Event", ""),
                        self.headers.get("X-Hub-Signature-256", ""),
                        body,
                    )
                )
        except Exception:  # noqa: BLE001 - private payload/errors must not reach HTTP logs
            status = 503
        body = json.dumps(
            {"received": status == 202, "deploymentAdmitted": False}
        ).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    os.umask(0o077)
    config = private_json("/etc/june/github-intake.json")
    origin = config["forwardOrigin"]
    if origin != "active-slot" and (
        not re.fullmatch(r"http://127\.0\.0\.1:[0-9]{4,5}", origin)
        or not 1024 <= urlsplit(origin).port <= 65535
    ):
        raise ValueError("invalid_forward_origin")
    if (
        type(config["port"]) is not int
        or not 1024 <= config["port"] <= 65535
        or config["port"] == urlsplit(origin).port
    ):
        raise ValueError("invalid_intake_port")
    inbox = Inbox(
        "/var/lib/june-github-intake/inbox.sqlite",
        config["secret"],
        config["installationId"],
    )

    def forward():
        while True:
            try:
                if inbox.forward_one(origin):
                    continue
            except Exception:  # noqa: BLE001 - forwarding cannot drop a private envelope
                time.sleep(5)  # Retain the same ID without logging private errors.
                continue
            time.sleep(5)

    threading.Thread(target=forward, daemon=True).start()
    server = Server(("0.0.0.0", config["port"]), Handler)
    server.inbox = inbox
    server.serve_forever()


if __name__ == "__main__":
    try:
        main()
    except Exception:  # noqa: BLE001 - final credential-redaction boundary
        raise SystemExit(
            "github_intake_stopped: inspect protected configuration"
        ) from None
