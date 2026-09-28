"""Core separation and durable no-replay boundaries; never launch Amp or SSH."""

import base64
import importlib.util
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "jobs_runner", Path(__file__).with_name("jobs_runner.py")
)
jobs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(jobs)


class JobsRunner(unittest.TestCase):
    def test_policy_is_separate_and_rejects_retargeting(self):
        config = {
            "command": ["/opt/amp"],
            "policyRevision": "v1",
            "workspaces": {"amp-june": "/work/june"},
        }
        payload = {
            "id": "a" * 64,
            "workspace": "amp-june",
            "directory": "/work/june",
            "policyRevision": "v1",
            "goal": "Inspect a fixture; $(false) 'quoted'",
        }

        def encode(value):
            return "june-job " + base64.urlsafe_b64encode(
                json.dumps(value).encode()
            ).decode().rstrip("=")

        original = encode(payload)
        job_id, directory, argv = jobs.command(original, config)
        self.assertEqual(job_id, payload["id"])
        self.assertEqual(directory, "/work/june")
        self.assertEqual(
            argv[3:9],
            [
                "--features",
                "fast",
                "--executor",
                "runner:homelab-amp",
                "--runner-dir",
                directory,
            ],
        )
        self.assertTrue(argv[-1].endswith(payload["goal"]))
        with self.assertRaises(ValueError):
            jobs.runner.command(
                original, {"command": ["/opt/amp"], "runnerDirectory": directory}
            )
        for denied in ("june-recovery-self-test", original + "; id", "id"):
            with self.assertRaises(ValueError):
                jobs.command(denied, config)
        for key, value in (
            ("directory", "/elsewhere"),
            ("policyRevision", "v2"),
            ("workspace", "recovery"),
            ("id", "bad"),
        ):
            with self.subTest(key=key), self.assertRaises(ValueError):
                jobs.command(encode({**payload, key: value}), config)

    def test_claim_survives_reopening_and_never_allows_second_dispatch(self):
        with tempfile.TemporaryDirectory() as directory:
            database = str(Path(directory) / "jobs.sqlite")
            jobs.claim(database, "a" * 64)
            with self.assertRaises(sqlite3.IntegrityError):
                jobs.claim(database, "a" * 64)
            jobs.claim(database, "b" * 64)


if __name__ == "__main__":
    unittest.main()
