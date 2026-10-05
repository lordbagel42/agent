"""Exercise the installed HAProxy binary with disposable loopback June slots.

Run with HAPROXY=/path/to/haproxy; no production services or credentials are used.
"""

import http.client
import os
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HOST = "june-mcp.raygen.dev"
TOKEN = "Bearer synthetic-mcp-proxy-test-credential"
BODY = b'{"jsonrpc":"2.0","id":7,"method":"tools/list"}'


class Slot(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        self.send_response(200 if self.server.ready else 503)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        self.server.requests.append((self.path, dict(self.headers), body))
        if self.server.disconnect:
            self.close_connection = True
            return
        self.send_response(200 if self.headers.get("Authorization") == TOKEN else 401)
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(self.server.label.encode())


class McpProxy(unittest.TestCase):
    def setUp(self):
        config = Path(__file__).with_name("june-mcp-proxy.cfg")
        self.assertTrue(
            config.is_file(), "MCP-only active-slot proxy configuration is missing"
        )
        binary = os.environ.get("HAPROXY") or shutil.which("haproxy")
        self.assertIsNotNone(binary, "Install HAProxy 3.0+ or set HAPROXY")
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.slots = []
        source = config.read_text()
        for name, port in (("blue", 3081), ("green", 3082)):
            server = ThreadingHTTPServer(("127.0.0.1", 0), Slot)
            server.ready = name == "green"
            server.label = name
            server.disconnect = False
            server.requests = []
            self.slots.append(server)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            self.addCleanup(server.server_close)
            self.addCleanup(server.shutdown)
            source = source.replace(
                f"127.0.0.1:{port}", f"127.0.0.1:{server.server_port}"
            )
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            self.port = reservation.getsockname()[1]
        source = source.replace("192.168.0.215:3085", f"127.0.0.1:{self.port}")
        local = Path(self.temp.name) / "proxy.cfg"
        local.write_text(source)
        subprocess.run(
            [binary, "-c", "-f", str(local)], check=True, capture_output=True
        )
        self.logs = self.enterContext(open(Path(self.temp.name) / "proxy.log", "w+"))
        self.proxy = subprocess.Popen(
            [binary, "-db", "-f", str(local)], stdout=self.logs, stderr=self.logs
        )
        self.addCleanup(self.stop_proxy)
        self.await_response(200, b"green")

    def stop_proxy(self):
        self.proxy.terminate()
        self.proxy.wait(timeout=5)

    def request(self, path="/mcp", method="POST", host=HOST, token=TOKEN):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        try:
            connection.request(
                method,
                path,
                BODY,
                {
                    "Host": host,
                    "Authorization": token,
                    "Content-Type": "application/json",
                    "Accept": "application/json, text/event-stream",
                    "Origin": f"https://{HOST}",
                },
            )
            response = connection.getresponse()
            return response.status, response.read()
        finally:
            connection.close()

    def await_response(self, status, body=None):
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            try:
                actual = self.request()
                if actual[0] == status and (body is None or actual[1] == body):
                    return
            except (OSError, http.client.HTTPException):
                pass
            time.sleep(0.1)
        self.fail(
            f"Proxy did not reach expected disposable-slot response {status}, {body!r}"
        )

    def test_only_exact_mcp_route_preserves_auth_and_body(self):
        blue, green = self.slots
        before = len(green.requests)
        for path in (
            "/operator/agents",
            "/health",
            "/console",
            "/mcp/",
            "/mcp?token=x",
            "/mcp/../operator/agents",
            "/%6dcp",
        ):
            self.assertEqual(self.request(path=path)[0], 404, path)
        self.assertEqual(self.request(method="GET")[0], 405)
        self.assertEqual(self.request(host="untrusted.example")[0], 403)
        for host in (f"untrusted.example, {HOST}", f"{HOST}, untrusted.example"):
            # HAProxy can reject malformed Host during parsing, before the ACL.
            self.assertIn(self.request(host=host)[0], (400, 403), host)
        self.assertEqual(len(green.requests), before)
        self.assertEqual(len(blue.requests), 0)
        self.assertEqual(self.request(token="Bearer invalid")[0], 401)
        self.assertEqual(self.request(), (200, b"green"))
        path, headers, body = green.requests[-1]
        self.assertEqual(
            (path, headers["host"], headers["authorization"], body),
            ("/mcp", HOST, TOKEN, BODY),
        )
        self.assertEqual(headers["origin"], f"https://{HOST}")

    def test_follows_readiness_in_both_directions_and_fails_closed(self):
        blue, green = self.slots
        green.ready = False
        self.await_response(503)
        before = sum(len(slot.requests) for slot in self.slots)
        self.assertEqual(self.request()[0], 503)
        self.assertEqual(sum(len(slot.requests) for slot in self.slots), before)
        blue.ready = True
        self.await_response(200, b"blue")
        blue.ready, green.ready = False, True
        self.await_response(200, b"green")

    def test_uncertain_delivery_is_not_retried_or_logged(self):
        _, green = self.slots
        green.disconnect = True
        before = len(green.requests)
        self.assertEqual(self.request()[0], 502)
        time.sleep(0.3)
        self.assertEqual(len(green.requests), before + 1)
        self.logs.flush()
        self.logs.seek(0)
        logs = self.logs.read()
        self.assertNotIn(TOKEN, logs)
        self.assertNotIn(BODY.decode(), logs)


if __name__ == "__main__":
    unittest.main()
