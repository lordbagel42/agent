"""Prepare a relocatable dependency archive on the Debian 13 x64 Actions runner.

No deployment credentials or runtime config. Source is exported from the exact
commit, not the working tree. The installed controller independently exports it.
"""

import argparse
import hashlib
import io
import json
import os
import platform
import stat
import subprocess
import tarfile
import tempfile
from pathlib import Path, PurePosixPath

# Kept explicit here: the trusted producer must not import candidate app or
# controller code. The consumer checks the exact exported source archive digest.
SOURCE = (
    "src",
    "tests",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "tsconfig.json",
    "vitest.config.ts",
    "biome.json",
    ".gitignore",
    ".npmrc",
    ".node-version",
)


def package(stage, output, revision, source_digest):
    manifest = json.dumps(
        {
            "version": 1,
            "revision": revision,
            "sourceSha256": source_digest,
            "platform": "debian13-x64",
            "node": "24.21.0",
            "pnpm": "10.33.0",
        }
    ).encode()
    with tarfile.open(output, "w:gz", compresslevel=1, dereference=False) as archive:
        info = tarfile.TarInfo("build.json")
        info.size, info.mode = len(manifest), 0o644
        archive.addfile(info, io.BytesIO(manifest))
        dependencies = stage / "node_modules"
        for path in [dependencies, *sorted(dependencies.rglob("*"))]:
            meta = path.lstat()
            if path.is_symlink():
                if os.path.isabs(
                    os.readlink(path)
                ) or not path.resolve().is_relative_to(dependencies):
                    raise ValueError("escaping_dependency_link")
            elif not (stat.S_ISREG(meta.st_mode) or stat.S_ISDIR(meta.st_mode)):
                raise ValueError("unsafe_dependency")
            info = archive.gettarinfo(str(path), arcname=str(path.relative_to(stage)))
            # pnpm may hardlink package files; ship independent regular bytes.
            if info.islnk():
                info.type, info.linkname, info.size = tarfile.REGTYPE, "", meta.st_size
            info.uid = info.gid = 0
            info.uname = info.gname = ""
            info.mode = 0o755 if path.is_dir() or meta.st_mode & 0o111 else 0o644
            if info.isfile():
                with path.open("rb") as content:
                    archive.addfile(info, content)
            else:
                archive.addfile(info)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("revision")
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    system = platform.freedesktop_os_release()
    if (
        platform.machine() != "x86_64"
        or system.get("ID") != "debian"
        or system.get("VERSION_ID") != "13"
    ):
        raise ValueError("unsupported_build_platform")
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"]).decode().strip()
    if args.revision != commit:
        raise ValueError("checkout_revision_mismatch")
    names = (
        subprocess.check_output(
            ["git", "ls-tree", "-r", "--name-only", "-z", commit, "--", *SOURCE]
        )
        .decode()
        .split("\0")
    )
    archive = subprocess.check_output(
        [
            "git",
            "archive",
            "--format=tar",
            commit,
            "--",
            *sorted({name.split("/")[0] for name in names if name}),
        ]
    )
    if len(archive) > 64 * 1024 * 1024:
        raise ValueError("source_too_large")
    preflight = Path(__file__).with_name("preflight.sh").resolve()
    with tempfile.TemporaryDirectory(prefix="june-build-") as temporary:
        stage = Path(temporary)
        with tarfile.open(fileobj=io.BytesIO(archive)) as source:
            members = source.getmembers()
            if len(members) > 10_000:
                raise ValueError("too_many_files")
            for member in members:
                parts = PurePosixPath(member.name).parts
                if (
                    not parts
                    or member.name.startswith("/")
                    or ".." in parts
                    or "\\" in member.name
                    or parts[0] not in SOURCE
                    or not (member.isfile() or member.isdir())
                    or any(
                        p.startswith(".env")
                        or p in (".git", "node_modules", ".data", ".codex")
                        for p in parts
                    )
                ):
                    raise ValueError("unsafe_source")
            source.extractall(stage, filter="data")
        subprocess.run(["sh", str(preflight)], cwd=stage, check=True)
        package(stage, args.output, commit, hashlib.sha256(archive).hexdigest())


if __name__ == "__main__":
    main()
