"""Release reuse must fail closed without a successful, matching PR image."""
import copy
from pathlib import Path
import runpy
import unittest


release = runpy.run_path(str(Path(__file__).resolve().parents[1] / ".github/scripts/release.py"))
REPOSITORY = "Qualified4/roadviewer-ha"


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.run = dict(id=100, event="pull_request", path=".github/workflows/build.yaml",
                        head_sha="tested-sha", head_repository={"full_name": REPOSITORY},
                        status="completed", conclusion="success")
        self.image = {"architecture": "amd64", "os": "linux", "config": {"Labels": {
            "io.roadviewer.source-tree": "tested-tree", "io.hass.version": "0.4.2",
            "io.hass.arch": "amd64", "io.hass.type": "app",
        }}}

    def select(self, runs):
        return release["select_run"](runs, REPOSITORY, "tested-sha")

    def test_successful_exact_pr_run(self):
        self.assertEqual(self.select([self.run]), 100)

    def test_untrusted_or_different_run_rejected(self):
        for key, value in (("event", "push"), ("event", "workflow_dispatch"),
                           ("head_sha", "old-sha"), ("path", ".github/workflows/other.yaml"),
                           ("head_repository", {"full_name": "fork/roadviewer-ha"})):
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                self.select([{**self.run, key: value}])

    def test_failed_or_running_newer_run_blocks_old_success(self):
        for result in ("failure", "cancelled", "skipped", None):
            newer = {**self.run, "id": 101, "conclusion": result}
            with self.subTest(result=result), self.assertRaises(ValueError):
                self.select([self.run, newer])
        with self.assertRaises(ValueError):
            self.select([{**self.run, "status": "in_progress"}])

    def test_no_run_rejected(self):
        with self.assertRaises(ValueError):
            self.select([])

    def test_missing_expired_or_ambiguous_artifacts_rejected(self):
        artifacts = [{"id": i, "name": f"tested-image-{arch}-2", "expired": False}
                     for i, arch in enumerate(("amd64", "arm64"), 10)]
        self.assertEqual(release["verify_artifacts"](artifacts, 2), "10,11")
        with self.assertRaises(ValueError):
            release["verify_artifacts"](artifacts, 3)
        for invalid in (artifacts[:1], [artifacts[0], {**artifacts[1], "expired": True}], artifacts + artifacts[:1]):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                release["verify_artifacts"](invalid, 2)

    def test_squash_commit_can_reuse_identical_source_tree(self):
        # The commit SHA changes on squash merge, but the full file tree must not.
        release["verify_image"](self.image, "amd64", "tested-tree", "0.4.2")
        local = {"Architecture": "amd64", "Os": "linux", "Config": self.image["config"]}
        release["verify_image"](local, "amd64", "tested-tree", "0.4.2")

    def test_different_source_version_or_architecture_rejected(self):
        for arch, tree, version in (("amd64", "changed-tree", "0.4.2"),
                                    ("amd64", "tested-tree", "0.4.3"),
                                    ("arm64", "tested-tree", "0.4.2")):
            with self.subTest(arch=arch, tree=tree, version=version), self.assertRaises(ValueError):
                release["verify_image"](self.image, arch, tree, version)
        for label in self.image["config"]["Labels"]:
            bad = copy.deepcopy(self.image)
            del bad["config"]["Labels"][label]
            with self.subTest(missing=label), self.assertRaises(ValueError):
                release["verify_image"](bad, "amd64", "tested-tree", "0.4.2")

    def test_arm64_home_assistant_architecture(self):
        self.image["architecture"] = "arm64"
        self.image["config"]["Labels"]["io.hass.arch"] = "aarch64"
        release["verify_image"](self.image, "arm64", "tested-tree", "0.4.2")

    def test_both_platforms_required_without_duplicates(self):
        entries = [{"platform": {"os": "linux", "architecture": arch}, "digest": f"digest-{arch}"}
                   for arch in ("amd64", "arm64")]
        self.assertEqual(release["release_platforms"]({"manifests": entries}),
                         {"amd64": "digest-amd64", "arm64": "digest-arm64"})
        for invalid in ([], entries[:1], entries + entries[:1]):
            with self.subTest(entries=invalid), self.assertRaises(ValueError):
                release["release_platforms"]({"manifests": invalid})


if __name__ == "__main__":
    unittest.main()
