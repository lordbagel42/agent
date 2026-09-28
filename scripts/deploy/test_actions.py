"""Actions preparation contract: remote evidence, hostile archives, local gates."""

import copy
import gzip
import hashlib
import io
import json
import os
import struct
import tarfile
import tempfile
import unittest
import zipfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import build_release
from test_deploy import FixtureHost, deploy


class ActionsPreparation(unittest.TestCase):
    def test_prepared_actions_release_passes_existing_local_activation_gates(self):
        with (
            tempfile.TemporaryDirectory() as tmp,
            patch.object(
                deploy.shutil,
                "disk_usage",
                return_value=SimpleNamespace(free=10 * 1024**3),
            ),
        ):
            root = Path(tmp)
            host = FixtureHost(root)
            host.config["healthSeconds"] = 5
            paths = (
                ".github/workflows/june-build.yml",
                "scripts/deploy/build_release.py",
                "scripts/deploy/preflight.sh",
            )
            for name in paths:
                host.commit(name, "reviewed policy")
            first = host.commit("src/console/view.ts", "one")
            host.prepare(first)
            host.switch(first)
            host.service("start")
            self.addCleanup(host.service, "stop")
            self.assertTrue(host.healthy(first))
            target = host.commit("src/console/view.ts", "two")
            host.config["actionsPolicy"] = {
                name: host.git("rev-parse", f"{target}:{name}") for name in paths
            }
            names = host.git(
                "ls-tree", "-r", "--name-only", target, "--", *deploy.SOURCE
            ).splitlines()
            source = host.git(
                "archive",
                "--format=tar",
                target,
                "--",
                *sorted({name.split("/")[0] for name in names}),
                binary=True,
            )
            stage = root / "producer"
            (stage / "node_modules/.bin").mkdir(parents=True)
            for name in ("tsx", "codex"):
                tool = stage / "node_modules/.bin" / name
                tool.write_text("#!/bin/sh\nexit 0\n")
                tool.chmod(0o755)
            artifact_path = root / "release.tar.gz"
            build_release.package(
                stage, artifact_path, target, hashlib.sha256(source).hexdigest()
            )
            bundled = io.BytesIO()
            with (
                patch.object(zipfile, "ZIP64_LIMIT", 32),
                zipfile.ZipFile(bundled, "w") as archive,
            ):
                archive.write(artifact_path, "release.tar.gz")
            host.actions = deploy.ActionsBuild()
            store = deploy.Store(root / "records", root / "feed.json", first)
            self.addCleanup(store.close)

            def download(_artifact, output):
                output.write(bundled.getvalue())
                output.seek(0)

            with (
                patch.object(host.actions, "artifact", return_value={"id": 29}),
                patch.object(host.actions, "download", download),
                patch.object(
                    host,
                    "build",
                    side_effect=AssertionError("local build must not run"),
                ),
            ):
                deploy.Deployer(host, store).tick()
            self.assertEqual(store.status(target), "healthy")
            self.assertEqual(host.current.resolve(), host.releases / target)
            marker = host.manifest(target)
            self.assertEqual(marker["binding"], "a" * 64)
            self.assertEqual(
                (host.releases / target / "src/console/view.ts").read_text(), "two"
            )
            self.assertEqual(
                (host.data / "messages").read_text(), "new messages must survive\n"
            )

    def test_download_verifies_digest_without_forwarding_api_credentials(self):
        body = b"opaque artifact bytes"
        artifact = {
            "id": 29,
            "size_in_bytes": len(body),
            "digest": "sha256:" + hashlib.sha256(body).hexdigest(),
        }
        client = deploy.ActionsBuild()

        class API:
            def open(self, request, timeout):
                assert (
                    request.full_url
                    == "https://api.github.com/repos/lordbagel42/agent/actions/artifacts/29/zip"
                )
                assert request.get_header("Authorization") == "Bearer fixture-secret"
                raise deploy.urllib.error.HTTPError(
                    request.full_url,
                    302,
                    "redirect",
                    {
                        "Location": "https://production.blob.core.windows.net/artifact?signature=private"
                    },
                    None,
                )

        class Storage:
            def open(self, request, timeout):
                assert request.get_header("Authorization") is None
                response = io.BytesIO(body)
                response.status = 200
                return response

        client.opener = Storage()
        with (
            patch.object(deploy.GitHubApp, "token", return_value="fixture-secret"),
            patch.object(deploy.urllib.request, "build_opener", return_value=API()),
        ):
            output = io.BytesIO()
            client.download(artifact, output)
            self.assertEqual(output.read(), body)
            artifact["digest"] = "sha256:" + "0" * 64
            with self.assertRaisesRegex(
                deploy.ActionsFailure, "actions_artifact_invalid"
            ):
                client.download(artifact, io.BytesIO())

    def test_download_outage_defers_next_poll_instead_of_repeating_preparation(self):
        client = deploy.ActionsBuild()
        client.cached, client.retry_at = ("b" * 40, {"id": 29}), float("inf")
        with (
            tempfile.TemporaryDirectory() as tmp,
            patch.object(
                client,
                "download",
                side_effect=deploy.ActionsDeferred("actions_unavailable"),
            ),
        ):
            with self.assertRaisesRegex(deploy.ActionsDeferred, "actions_unavailable"):
                client.install("b" * 40, "d" * 64, Path(tmp))
            with self.assertRaisesRegex(deploy.ActionsDeferred, "actions_unavailable"):
                client.artifact("b" * 40)

    def test_preparation_requires_operator_pinned_build_policy(self):
        with tempfile.TemporaryDirectory() as tmp:
            host = FixtureHost(Path(tmp))
            host.actions = deploy.ActionsBuild()
            paths = (
                ".github/workflows/june-build.yml",
                "scripts/deploy/build_release.py",
                "scripts/deploy/preflight.sh",
            )
            for name in paths:
                host.commit(name, f"reviewed {name}")
            commit = host.fetch()
            host.config["actionsPolicy"] = {
                name: host.git("rev-parse", f"{commit}:{name}") for name in paths
            }
            with patch.object(host.actions, "artifact", return_value={}):
                self.assertEqual(host.preparation_ready(commit), "actions_build_ready")
                changed = host.commit(paths[1], "silently skip checks")
                with self.assertRaisesRegex(
                    deploy.ActionsFailure, "actions_policy_changed"
                ):
                    host.preparation_ready(changed)

    def test_packaged_dependencies_relocate_without_hardlinks_or_private_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            stage, target = root / "build", root / "release"
            tool = stage / "node_modules/.pnpm/tool/bin"
            tool.parent.mkdir(parents=True)
            tool.write_text("#!/bin/sh\necho relocated\n")
            tool.chmod(0o755)
            os.link(tool, tool.with_name("duplicate"))
            (stage / "node_modules/.bin").mkdir()
            (stage / "node_modules/.bin/tool").symlink_to("../.pnpm/tool/bin")
            (stage / ".env").write_text("private")
            output = root / "release.tar.gz"
            build_release.package(stage, output, "b" * 40, "d" * 64)
            target.mkdir()
            with output.open("rb") as archive:
                deploy.extract_dependencies(archive, target, "b" * 40, "d" * 64)
            self.assertFalse((target / ".env").exists())
            self.assertEqual(
                (target / "node_modules/.bin/tool").read_text(),
                "#!/bin/sh\necho relocated\n",
            )
            copied = target / "node_modules/.pnpm/tool/bin"
            self.assertEqual(copied.stat().st_nlink, 1)
            self.assertEqual(
                copied.with_name("duplicate").read_bytes(), copied.read_bytes()
            )

    def test_only_successful_exact_main_push_workflow_produces_a_candidate(self):
        sha = "b" * 40
        run = {
            "id": 23,
            "workflow_id": 7,
            "path": ".github/workflows/june-build.yml",
            "event": "push",
            "head_branch": "main",
            "head_sha": sha,
            "head_repository": {"full_name": "lordbagel42/agent"},
            "status": "completed",
            "conclusion": "success",
        }
        artifact = {
            "id": 29,
            "name": f"june-{sha}",
            "expired": False,
            "size_in_bytes": 1_477_678_771,
            "digest": "sha256:" + "c" * 64,
            "workflow_run": {"id": 23, "head_sha": sha, "head_branch": "main"},
        }

        def request(path):
            if path == "actions/workflows/june-build.yml":
                return {"id": 7, "path": ".github/workflows/june-build.yml"}
            if (
                path
                == f"actions/workflows/7/runs?head_sha={sha}&branch=main&event=push&per_page=1"
            ):
                return {"workflow_runs": [run]}
            if path == "actions/runs/23/artifacts?per_page=100":
                return {"total_count": 1, "artifacts": [artifact]}
            raise AssertionError(path)

        class API:
            def open(self, req, timeout):
                prefix = "https://api.github.com/repos/lordbagel42/agent/"
                assert req.full_url.startswith(prefix), req.full_url
                assert req.get_header("Authorization") == "Bearer fixture-secret"
                response = io.BytesIO(
                    json.dumps(request(req.full_url[len(prefix) :])).encode()
                )
                response.status = 200
                return response

        with (
            patch.object(deploy.GitHubApp, "token", return_value="fixture-secret"),
            patch.object(deploy.urllib.request, "build_opener", return_value=API()),
        ):
            self.assertEqual(deploy.ActionsBuild().artifact(sha), artifact)
            for field, bad in (
                ("head_sha", "a" * 40),
                ("head_branch", "feature"),
                ("event", "pull_request"),
                ("workflow_id", 8),
                ("path", ".github/workflows/other.yml"),
                ("head_repository", {"full_name": "attacker/agent"}),
            ):
                with self.subTest(field=field):
                    original = run[field]
                    run[field] = bad
                    with self.assertRaisesRegex(
                        deploy.ActionsFailure, "actions_artifact_invalid"
                    ):
                        deploy.ActionsBuild().artifact(sha)
                    run[field] = original
            run["status"], run["conclusion"] = "in_progress", None
            with self.assertRaisesRegex(deploy.ActionsDeferred, "actions_pending"):
                deploy.ActionsBuild().artifact(sha)
            run["status"], run["conclusion"] = "completed", "failure"
            with self.assertRaisesRegex(deploy.ActionsFailure, "actions_build_failed"):
                deploy.ActionsBuild().artifact(sha)
            run["conclusion"] = "success"
            for field, bad in (
                ("expired", True),
                ("digest", None),
                ("workflow_run", {"id": 24}),
            ):
                with self.subTest(artifact=field):
                    original = artifact[field]
                    artifact[field] = bad
                    with self.assertRaisesRegex(
                        deploy.ActionsFailure, "actions_artifact_invalid"
                    ):
                        deploy.ActionsBuild().artifact(sha)
                    artifact[field] = original

    def test_dependency_archive_cannot_replace_source_or_escape_and_preserves_links(
        self,
    ):
        sha, source = "b" * 40, "d" * 64
        manifest = {
            "version": 1,
            "revision": sha,
            "sourceSha256": source,
            "platform": "debian13-x64",
            "node": "24.21.0",
            "pnpm": "10.33.0",
        }

        def archive(extra=None, metadata=None):
            result = io.BytesIO()
            with tarfile.open(fileobj=result, mode="w:gz") as tar:
                for name, data in (
                    ("build.json", json.dumps(metadata or manifest).encode()),
                    ("node_modules/.pnpm/tool/bin", b"#!/bin/sh\nexit 0\n"),
                ):
                    entry = tarfile.TarInfo(name)
                    entry.size, entry.mode = len(data), 0o755
                    tar.addfile(entry, io.BytesIO(data))
                link = tarfile.TarInfo("node_modules/.bin/tool")
                link.type, link.linkname = tarfile.SYMTYPE, "../.pnpm/tool/bin"
                tar.addfile(link)
                if extra:
                    tar.addfile(extra)
            result.seek(0)
            return result

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            valid = root / "valid"
            valid.mkdir()
            deploy.extract_dependencies(archive(), valid, sha, source)
            tool = valid / "node_modules/.bin/tool"
            self.assertTrue(tool.is_symlink())
            self.assertEqual(tool.read_text(), "#!/bin/sh\nexit 0\n")
            self.assertTrue(tool.stat().st_mode & 0o111)
            for index, (name, kind, target) in enumerate(
                (
                    ("../outside", tarfile.REGTYPE, ""),
                    ("/tmp/outside", tarfile.REGTYPE, ""),
                    ("src/main.ts", tarfile.REGTYPE, ""),
                    (".june-release.json", tarfile.REGTYPE, ""),
                    ("node_modules/link", tarfile.SYMTYPE, "../../outside"),
                    ("node_modules/link", tarfile.SYMTYPE, "/etc/passwd"),
                    (
                        "node_modules/hard",
                        tarfile.LNKTYPE,
                        "node_modules/.pnpm/tool/bin",
                    ),
                    ("node_modules/device", tarfile.CHRTYPE, ""),
                    ("node_modules/.pnpm/tool/bin", tarfile.REGTYPE, ""),
                )
            ):
                with self.subTest(name=name):
                    stage = root / str(index)
                    stage.mkdir()
                    bad = tarfile.TarInfo(name)
                    bad.type, bad.linkname = kind, target
                    with self.assertRaisesRegex(
                        ValueError, "invalid_dependency_artifact"
                    ):
                        deploy.extract_dependencies(archive(bad), stage, sha, source)
            changed = copy.deepcopy(manifest)
            changed["revision"] = "a" * 40
            with self.assertRaisesRegex(ValueError, "invalid_dependency_artifact"):
                deploy.extract_dependencies(
                    archive(metadata=changed), root, sha, source
                )

    def test_waiting_for_actions_never_builds_drains_or_loses_pending_work(self):
        with tempfile.TemporaryDirectory() as tmp:
            host = FixtureHost(Path(tmp))
            first = host.commit("src/console/view.ts", "one")
            host.prepare(first)
            host.switch(first)
            host.service("start")
            self.addCleanup(host.service, "stop")
            host.config["healthSeconds"] = 5
            self.assertTrue(host.healthy(first))
            store = deploy.Store(Path(tmp) / "records", Path(tmp) / "feed.json", first)
            self.addCleanup(store.close)
            target = host.commit("src/console/view.ts", "two")
            recovery = deploy.Recovery(store)
            # Historical ordinary waits must not become legacy operator holds.
            store.event(target, "deferred", "actions_pending")
            loop = deploy.Deployer(host, store, recovery=recovery)
            with patch.object(
                host,
                "preparation_ready",
                side_effect=[
                    deploy.ActionsDeferred("actions_pending"),
                    deploy.ActionsDeferred("actions_unavailable"),
                ],
            ):
                loop.tick()
                loop.tick()
            self.assertEqual(store.get("recovery"), "")
            self.assertEqual(store.get("operatorHold"), "")
            self.assertEqual(store.status(target), "deferred")
            self.assertIn(target, json.loads(store.get("queue"))["pending"])
            self.assertFalse((host.data / "drains").exists())
            self.assertFalse((host.releases / target).exists())
            loop.tick()
            self.assertEqual(store.status(target), "healthy")
            failed = host.commit("src/console/view.ts", "three")
            real_run = deploy.subprocess.run
            with (
                patch.object(
                    host,
                    "preparation_ready",
                    side_effect=deploy.ActionsFailure("actions_build_failed"),
                ),
                patch.object(deploy.subprocess, "run") as dispatch,
            ):
                # Preserve real Git and fixture calls, intercept systemd only.
                dispatch.side_effect = lambda args, **kwargs: (
                    None if args[0] == "systemctl" else real_run(args, **kwargs)
                )
                loop.tick()
            self.assertEqual(store.status(failed), "failed")
            self.assertEqual(
                json.loads(store.get("recovery"))["reason"], "actions_build_failed"
            )
            self.assertEqual(
                (host.data / "starts").read_text().splitlines(), [first, target]
            )
            self.assertEqual(
                (host.data / "messages").read_text(), "new messages must survive\n"
            )

    def test_metadata_is_bounded_before_tarfile_parses_it(self):
        for kind in (tarfile.XHDTYPE, tarfile.XGLTYPE, tarfile.GNUTYPE_LONGNAME):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as tmp:
                header = tarfile.TarInfo("metadata")
                header.type, header.size = kind, 2 * 1024 * 1024
                payload = header.tobuf() + b"x" * header.size
                # No semantic member follows: reject before the parser reads metadata.
                with (
                    patch.object(
                        tarfile.TarInfo,
                        "_proc_pax",
                        side_effect=AssertionError("unbounded parse"),
                    ) as pax,
                    patch.object(
                        tarfile.TarInfo,
                        "_proc_gnulong",
                        side_effect=AssertionError("unbounded parse"),
                    ) as long,
                ):
                    with self.assertRaisesRegex(
                        ValueError, "invalid_dependency_artifact"
                    ):
                        deploy.extract_dependencies(
                            io.BytesIO(gzip.compress(payload)),
                            Path(tmp),
                            "b" * 40,
                            "d" * 64,
                        )
                    pax.assert_not_called()
                    long.assert_not_called()

        # Cumulative small headers also hit the budget before a parser call.
        header = deploy.DependencyHeaders("metadata")
        header.type, header.size = tarfile.XHDTYPE, 512
        source = SimpleNamespace(dependency_metadata_bytes=16 * 1024**2 - 512)
        with patch.object(tarfile.TarInfo, "_proc_member") as parse:
            header._proc_member(source)
            parse.assert_called_once()
            with self.assertRaisesRegex(ValueError, "dependency_metadata_limit"):
                header._proc_member(source)
            parse.assert_called_once()
        # Every decompressed byte consumes the stream budget, even tar padding.
        stream = deploy.DependencyStream(io.BytesIO(b"x" * 1025))
        stream.remaining = 1024
        self.assertEqual(len(stream.read(1024)), 1024)
        with self.assertRaisesRegex(ValueError, "dependency_stream_limit"):
            stream.read(1)

    def test_sparse_and_global_pax_are_rejected_before_expansion(self):
        for metadata, processor in (
            ({"GNU.sparse.size": "1"}, "_proc_gnusparse_00"),
            ({"GNU.sparse.map": "0,1"}, "_proc_gnusparse_01"),
            ({"GNU.sparse.major": "1", "GNU.sparse.minor": "0"}, "_proc_gnusparse_10"),
        ):
            with self.subTest(metadata=metadata), tempfile.TemporaryDirectory() as tmp:
                archive = io.BytesIO()
                with tarfile.open(fileobj=archive, mode="w:gz") as tar:
                    header = tarfile.TarInfo("build.json")
                    header.pax_headers = metadata
                    tar.addfile(header)
                archive.seek(0)
                with patch.object(tarfile.TarInfo, processor) as parse:
                    with self.assertRaisesRegex(
                        ValueError, "invalid_dependency_artifact"
                    ):
                        deploy.extract_dependencies(
                            archive, Path(tmp), "b" * 40, "d" * 64
                        )
                    parse.assert_not_called()
        header = deploy.DependencyHeaders("global")
        header.type, header.size = tarfile.XGLTYPE, 1
        with patch.object(tarfile.TarInfo, "_proc_pax") as parse:
            with self.assertRaisesRegex(ValueError, "unsupported_dependency_header"):
                header._proc_member(SimpleNamespace())
            parse.assert_not_called()

    def test_zip_directory_is_bounded_before_zipfile_construction(self):
        client = deploy.ActionsBuild()
        for zip64 in (False, True):
            for count, size in ((1, 65537), (2, 100)):
                with (
                    self.subTest(zip64=zip64, count=count),
                    tempfile.TemporaryDirectory() as tmp,
                ):
                    payload = b"\0" * size
                    if zip64:
                        payload += struct.pack(
                            zipfile.structEndArchive64,
                            zipfile.stringEndArchive64,
                            44,
                            45,
                            45,
                            0,
                            0,
                            count,
                            count,
                            size,
                            0,
                        )
                        payload += struct.pack(
                            zipfile.structEndArchive64Locator,
                            zipfile.stringEndArchive64Locator,
                            0,
                            size,
                            1,
                        )
                    # ZIP64 effective values must override these innocuous values.
                    payload += struct.pack(
                        zipfile.structEndArchive,
                        zipfile.stringEndArchive,
                        0,
                        0,
                        1 if zip64 else count,
                        1 if zip64 else count,
                        100 if zip64 else size,
                        0,
                        0,
                    )
                    with (
                        patch.object(client, "artifact", return_value={}),
                        patch.object(
                            client,
                            "download",
                            side_effect=lambda _a, output, data=payload: output.write(
                                data
                            ),
                        ),
                        patch.object(zipfile, "ZipFile") as parse,
                    ):
                        with self.assertRaisesRegex(
                            deploy.ActionsFailure, "actions_artifact_invalid"
                        ):
                            client.install("b" * 40, "d" * 64, Path(tmp))
                        parse.assert_not_called()


if __name__ == "__main__":
    unittest.main()
