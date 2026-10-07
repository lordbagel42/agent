"""Synthetic App grants only; never contacts GitHub or live debug ingress."""

import importlib.util
import io
import json
import subprocess
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import Mock, patch


class Renewal(unittest.TestCase):
    def setUp(self):
        path = Path(__file__).with_name("issue_credentials.py")
        self.assertTrue(path.exists(), "renewal is not implemented")
        spec = importlib.util.spec_from_file_location("issue_credentials", path)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.config = {
            "origin": "https://debug.example.test",
            "tokenFile": "/etc/june-issues/refresh-token",
            "githubApp": {
                "appId": 123,
                "installationId": 456,
                "privateKeyFile": "/etc/june/github-app.pem",
            },
        }
        self.renewer = self.module.Renewer(self.config)
        self.now = 1_791_374_400
        self.clock = patch.object(
            self.module.time, "time", side_effect=lambda: self.now
        )
        self.clock.start()
        self.addCleanup(self.clock.stop)
        self.monotonic = patch.object(self.module.time, "monotonic", return_value=100)
        self.monotonic.start()
        self.addCleanup(self.monotonic.stop)
        self.private = patch.object(
            self.module.issues, "read_private", return_value=b"r" * 48
        )
        self.private.start()
        self.addCleanup(self.private.stop)
        self.grant = {
            "token": "ghs_synthetic",
            "expires_at": datetime.fromtimestamp(
                self.now + 3600, timezone.utc
            ).isoformat(),
            "permissions": {"issues": "write", "contents": "read", "metadata": "read"},
            "repositories": [{"full_name": "lordbagel42/agent"}],
        }
        self.installation = {
            "id": 456,
            "app_id": 123,
            "account": {"login": "lordbagel42"},
        }
        self.mints = []
        self.deliveries = []

        def api(_token, method, path, body=None):
            if method == "GET":
                self.assertEqual(path, "repos/lordbagel42/agent/installation")
                return self.installation
            self.assertEqual(
                (method, path), ("POST", "app/installations/456/access_tokens")
            )
            self.mints.append(body)
            return self.grant

        self.renewer.github.request = api

        def deliver(request, timeout):
            self.deliveries.append(request)
            self.assertEqual(timeout, 10)
            response = io.BytesIO(b"")
            response.status = 204
            return response

        self.renewer.opener = Mock(open=deliver)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        key = Path(self.temp.name) / "app.pem"
        subprocess.run(
            ["openssl", "genrsa", "-out", str(key), "2048"],
            check=True,
            capture_output=True,
        )
        pem = patch.object(
            self.module.deploy, "private_file", return_value=key.read_text()
        )
        pem.start()
        self.addCleanup(pem.stop)

    def test_scoped_mint_repeated_delivery_and_early_rotation(self):
        self.renewer.poll_once()
        self.renewer.poll_once()  # Restores a restarted site's empty in-memory cache.
        self.assertEqual(
            self.mints,
            [
                {
                    "repositories": ["agent"],
                    "permissions": {"issues": "write", "contents": "read"},
                }
            ],
        )
        for request in self.deliveries:
            self.assertEqual(
                request.full_url, "https://debug.example.test/api/issue-github-token"
            )
            self.assertEqual(request.get_header("Authorization"), "Bearer " + "r" * 48)
            self.assertEqual(request.get_header("User-agent"), "june-issue-renewer")
            self.assertEqual(
                json.loads(request.data),
                {
                    "version": 1,
                    "token": self.grant["token"],
                    "expiresAt": self.grant["expires_at"],
                },
            )
        self.now += 51 * 60
        self.grant.update(
            token="ghs_rotated",
            expires_at=datetime.fromtimestamp(
                self.now + 3600, timezone.utc
            ).isoformat(),
        )
        self.renewer.poll_once()
        self.assertEqual(len(self.mints), 2)
        self.assertEqual(json.loads(self.deliveries[-1].data)["token"], "ghs_rotated")

    def test_broader_wrong_repository_and_invalid_lifetime_never_reach_site(self):
        for field, value in [
            ("permissions", {"issues": "write", "contents": "write"}),
            ("repositories", [{"full_name": "lordbagel42/another"}]),
            (
                "expires_at",
                datetime.fromtimestamp(self.now + 120, timezone.utc).isoformat(),
            ),
            (
                "expires_at",
                datetime.fromtimestamp(self.now + 3700, timezone.utc).isoformat(),
            ),
        ]:
            with self.subTest(field=field, value=value):
                original = self.grant[field]
                self.grant[field] = value
                with self.assertRaises(ValueError):
                    self.renewer.poll_once()
                self.grant[field] = original
        self.assertEqual(self.deliveries, [])

    def test_transport_denies_http_redirects_and_non_acknowledgments(self):
        with self.assertRaises(ValueError):
            self.module.Renewer({**self.config, "origin": "http://127.0.0.1:3092"})
        with self.assertRaises(ValueError):
            self.module.deploy.NoRedirect().redirect_request(
                None, None, 307, "", {}, "https://other.test"
            )
        response = io.BytesIO(b"sensitive server response must not escape")
        response.status = 403
        self.renewer.opener = Mock(open=Mock(return_value=response))
        with self.assertRaisesRegex(ValueError, "^issue_credential_delivery_failed$"):
            self.renewer.poll_once()
        self.assertTrue(response.closed)


if __name__ == "__main__":
    unittest.main()
