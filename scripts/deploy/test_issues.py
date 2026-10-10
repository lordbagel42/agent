"""Recovery dispatch must not depend on the issue tracker. Never launches agents."""

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


class Issues(unittest.TestCase):
    def setUp(self):
        path = Path(__file__).with_name("issues.py")
        spec = importlib.util.spec_from_file_location("issues", path)
        self.issues = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.issues)
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)

    def test_recovery_records_source_before_launch_without_http_dependency(self):
        deploy = self.issues.deploy_module()
        store = deploy.Store(self.root / "records", self.root / "feed.json", "a" * 40)
        self.addCleanup(store.close)
        store.set(
            "recovery",
            json.dumps(
                {
                    "incident": 17,
                    "revision": "b" * 40,
                    "reason": "health_failed",
                    "phase": "pending",
                }
            ),
        )

        def no_launch(*_args, **_kwargs):
            # The launch fence and local metadata are committed before the
            # subprocess; only the independent exporter is allowed to do HTTP.
            with deploy.sqlite3.connect(
                self.root / "records/deploy.sqlite", timeout=0
            ) as db:
                db.execute("BEGIN IMMEDIATE")
                record = json.loads(
                    db.execute(
                        "SELECT value FROM state WHERE key='issue-source:recovery:17'"
                    ).fetchone()[0]
                )
                self.assertEqual(
                    record,
                    {"source": "recovery:17", "phase": "running", "revision": "b" * 40},
                )
            raise OSError("fixture refuses all real agents")

        with (
            patch.object(deploy.urllib.request, "build_opener") as http,
            patch.object(deploy.subprocess, "Popen", side_effect=no_launch),
            self.assertRaises(OSError),
        ):
            deploy.dispatch_recovery(
                {
                    "ampRecovery": {
                        "command": ["/fixture/never-amp"],
                        "runnerDirectory": str(self.root),
                    },
                    "issueTracker": {
                        "origin": "https://debug.raygen.dev",
                        "tokenFile": str(self.root / "absent-token"),
                    },
                },
                17,
                self.root / "records/deploy.sqlite",
            )
        http.assert_not_called()
        self.assertEqual(
            json.loads(store.get("issue-source:recovery:17"))["phase"], "unknown"
        )



if __name__ == "__main__":
    unittest.main()
