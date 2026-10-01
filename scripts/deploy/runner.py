"""Root-installed SSH forced command. Runs as the authenticated Amp account."""

import importlib.util
import json
import os
import pwd
import re
import shlex
import stat
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "deploy", Path(__file__).with_name("deploy.py")
)
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)

PROBE = (
    "This is an authorized read-only June recovery transport self-test, not a recovery. "
    "No production incident exists for this test. Do not use tools, read files, "
    "contact services or other threads, claim ownership, or change anything. "
    "Reply exactly JUNE_RECOVERY_TRANSPORT_OK and end the turn."
)


def command(original, config):
    cli, directory = config["command"], config["runnerDirectory"]
    if (
        not isinstance(cli, list)
        or len(cli) != 1
        or not isinstance(cli[0], str)
        or not Path(cli[0]).is_absolute()
        or not isinstance(directory, str)
        or not Path(directory).is_absolute()
        or len(original) > 16384
    ):
        raise ValueError("invalid_runner_command")
    prefix = [
        *cli,
        "--mode",
        "ultra",
        "--features",
        "fast",
        "--executor",
        "runner:homelab-amp",
        "--runner-dir",
        directory,
        "--stream-json",
        "--no-archive-after-execute",
        "--title",
    ]
    if original == "june-recovery-self-test":
        return [*prefix, "June recovery transport self-test", "--execute", PROBE]
    argv = shlex.split(original)
    if (
        len(argv) != len(prefix) + 3
        or argv[: len(prefix)] != prefix
        or argv[-2] != "--execute"
    ):
        raise ValueError("invalid_runner_command")
    match = re.match(
        r"June deployment failed\. Incident ([1-9][0-9]{0,18}), "
        r"revision ([0-9a-f]{40}), reason ([a-z_]+|None)\. ",
        argv[-1],
    )
    if match is None:
        raise ValueError("invalid_runner_prompt")
    number, commit, reason = match.groups()
    if reason != "None" and reason not in deploy.GitHubStatuses.REASONS:
        raise ValueError("invalid_runner_reason")
    if argv[-3] != f"Recover June deployment incident {number}" or argv[
        -1
    ] != deploy.recovery_prompt(int(number), commit, reason):
        raise ValueError("invalid_runner_prompt")
    return argv


def main():
    fd = os.open("/etc/june-recovery/runner.json", os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd) as file:
        metadata = os.fstat(file.fileno())
        if (
            metadata.st_uid != 0
            or metadata.st_mode & 0o022
            or not stat.S_ISREG(metadata.st_mode)
        ):
            raise ValueError("unsafe_runner_config")
        config = json.load(file)
    argv = command(os.environ.get("SSH_ORIGINAL_COMMAND", ""), config)
    execute(argv, config["runnerDirectory"])


def execute(argv, directory):
    user = pwd.getpwuid(os.getuid())
    os.chdir(directory)
    # Amp accepts piped input alongside --execute. SSH stdin is not prompt data.
    fd = os.open(os.devnull, os.O_RDONLY)
    os.dup2(fd, 0, inheritable=True)
    if fd != 0:
        os.close(fd)
    # No SSH-supplied environment reaches Amp. Credentials remain in its own home.
    os.execve(
        argv[0],
        argv,
        {
            "HOME": user.pw_dir,
            "USER": user.pw_name,
            "LOGNAME": user.pw_name,
            "PATH": "/usr/local/bin:/usr/bin:/bin",
            "LANG": "C.UTF-8",
        },
    )


if __name__ == "__main__":
    try:
        main()
    except Exception:  # noqa: BLE001 - do not echo untrusted commands or private paths
        raise SystemExit("june_recovery_command_denied") from None
