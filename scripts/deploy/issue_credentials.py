"""Root-only GitHub App renewal on June's host, separate from source metadata.

Uses the existing App key in place; never copy it to the debug host or Amp.
Only agent Issues-write/Contents-read tokens cross the reviewed HTTPS route.
Refresh credentials, tokens, grants and provider responses never enter logs,
argv, persistent state, source receipts or agent tools. See docs/debug-site.md
for the required ingress trust review and companion updater installation.
"""

import importlib.util
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location(
    "issues", Path(__file__).with_name("issues.py")
)
issues = importlib.util.module_from_spec(spec)
spec.loader.exec_module(issues)
spec = importlib.util.spec_from_file_location(
    "deploy", Path(__file__).with_name("deploy.py")
)
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)

CONFIG = "/etc/june-issues/credentials.json"
POLL_SECONDS = 60


def validate_config(config):
    if not isinstance(config, dict) or set(config) != {
        "origin",
        "tokenFile",
        "githubApp",
    }:
        raise ValueError("invalid_renewal_config")
    origin = issues.validate_origin(config["origin"])
    if not origin.startswith("https://") or not issues.absolute(config["tokenFile"]):
        raise ValueError("invalid_renewal_config")
    app = config["githubApp"]
    if (
        not isinstance(app, dict)
        or set(app) != {"appId", "installationId", "privateKeyFile"}
        or any(not issues.positive(app[key]) for key in ("appId", "installationId"))
        or not issues.absolute(app["privateKeyFile"])
    ):
        raise ValueError("invalid_renewal_config")
    return {**config, "origin": origin}


class Renewer:
    def __init__(self, config):
        self.config = validate_config(config)
        self.github = deploy.GitHubApp(
            self.config["githubApp"], {"issues": "write", "contents": "read"}
        )
        self.opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}), deploy.NoRedirect()
        )
        self.deadline = 0

    def poll_once(self):
        # Rotate with ten minutes remaining on either clock, leaving ample room
        # for transient delivery failures and the site's early-expiry budget.
        if (
            time.time() >= self.github.app_token_expiry - 600
            or time.monotonic() >= self.deadline
        ):
            self.github.app_token = None
        cached = self.github.app_token is not None
        token = self.github.token()  # Validates exact repository and permissions.
        remaining = self.github.app_token_expiry - time.time()
        if not 300 < remaining <= 3660 or not re.fullmatch(
            r"[A-Za-z0-9._~-]{1,4096}", token
        ):
            self.github.app_token = None
            raise ValueError("invalid_issue_grant")
        if not cached:
            self.deadline = time.monotonic() + remaining - 600
        refresh = (
            issues.read_private(self.config["tokenFile"], limit=4096).decode().strip()
        )
        if not re.fullmatch(r"[A-Za-z0-9._~+/-]{32,4096}=*", refresh):
            raise ValueError("invalid_renewal_credential")
        request = urllib.request.Request(
            self.config["origin"] + "/api/issue-github-token",
            data=json.dumps(
                {
                    "version": 1,
                    "token": token,
                    "expiresAt": datetime.fromtimestamp(
                        self.github.app_token_expiry, timezone.utc
                    ).isoformat(),
                }
            ).encode(),
            method="POST",
            headers={
                "Authorization": f"Bearer {refresh}",
                "Content-Type": "application/json",
                "User-Agent": "june-issue-renewer",
            },
        )
        try:
            with self.opener.open(request, timeout=10) as response:
                if response.status != 204:
                    raise ValueError("issue_credential_delivery_failed")
        except urllib.error.HTTPError as error:
            error.close()  # Never read or log a proxy/provider response body.
            raise ValueError("issue_credential_delivery_failed") from None


def main():
    if os.geteuid() != 0:
        raise ValueError("renewal_root_required")
    os.umask(0o077)
    config = issues.parse_json(issues.read_private(CONFIG, limit=4096))
    renewer = Renewer(config)
    while True:
        try:
            # Re-delivery restores an empty site cache after restart; accepting
            # the same grant never extends its expiry or repeats an issue write.
            renewer.poll_once()
        except Exception:  # noqa: BLE001 - fixed-code log; no credential/provider details
            print("june_issue_credential_unavailable", file=sys.stderr, flush=True)
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    try:
        main()
    except Exception:  # noqa: BLE001 - no config, key or subprocess errors in logs
        raise SystemExit("june_issue_credential_configuration_invalid") from None
