"""Reuse successful PR images; never rebuild or execute image contents at release time."""
import json
import os
from pathlib import Path
import subprocess
import sys
from urllib.parse import urlencode
from urllib.request import Request, urlopen


def require(condition, message):
    if not condition:
        raise ValueError(message)


def select_run(runs, repository, sha):
    candidates = [run for run in runs if (
        run.get("event") == "pull_request"
        and run.get("path") == ".github/workflows/build.yaml"
        and run.get("head_sha") == sha
        and (run.get("head_repository") or {}).get("full_name") == repository
    )]
    require(candidates, "No PR validation for this exact commit; open or update the PR first.")
    run = max(candidates, key=lambda item: item["id"])
    require(run.get("status") == "completed" and run.get("conclusion") == "success",
            "The latest PR validation has not succeeded; do not reuse an older success.")
    return run["id"]


def verify_artifacts(artifacts, attempt):
    ids = []
    for arch in ("amd64", "arm64"):
        matches = [item for item in artifacts if item["name"] == f"tested-image-{arch}-{attempt}"]
        require(len(matches) == 1 and not matches[0]["expired"],
                f"Missing or expired {arch} image; rerun the complete PR validation.")
        ids.append(str(matches[0]["id"]))
    return ",".join(ids)


def verify_image(image, arch, tree, version):
    config = image.get("Config", image.get("config", {}))
    labels = config.get("Labels") or {}
    require(image.get("Architecture", image.get("architecture")) == arch,
            f"Wrong image architecture: expected {arch}")
    require(image.get("Os", image.get("os")) == "linux", "Expected a Linux image")
    require(labels.get("io.roadviewer.source-tree") == tree,
            "Image source differs from this checkout; update the PR and validate again.")
    require(labels.get("io.hass.version") == version, "Image version does not match config.yaml")
    require(labels.get("io.hass.arch") == {"amd64": "amd64", "arm64": "aarch64"}[arch],
            "Home Assistant architecture label does not match")
    require(labels.get("io.hass.type") == "app", "Expected a Home Assistant app image")


def release_platforms(manifest):
    entries = manifest.get("manifests", [])
    platforms = {(item["platform"]["os"], item["platform"]["architecture"]) for item in entries}
    require(len(entries) == 2 and platforms == {("linux", "amd64"), ("linux", "arm64")},
            "Release must contain exactly linux/amd64 and linux/arm64")
    return {item["platform"]["architecture"]: item["digest"] for item in entries}


def github(path):
    request = Request(f"https://api.github.com/repos/{os.environ['GITHUB_REPOSITORY']}/{path}", headers={
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {os.environ['GH_TOKEN']}",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "RoadViewer-release",
    })
    with urlopen(request, timeout=30) as response:
        return json.load(response)


def inspect(reference, field):
    return json.loads(subprocess.check_output([
        "docker", "buildx", "imagetools", "inspect", reference,
        "--format", "{{json ." + field + "}}",
    ], text=True))


def main():
    command = sys.argv[1]
    if command == "select-run":
        query = urlencode({"event": "pull_request", "head_sha": os.environ["GITHUB_SHA"], "per_page": 100})
        runs = github(f"actions/workflows/build.yaml/runs?{query}")["workflow_runs"]
        run_id = select_run(runs, os.environ["GITHUB_REPOSITORY"], os.environ["GITHUB_SHA"])
        attempt = next(run["run_attempt"] for run in runs if run["id"] == run_id)
        ids = verify_artifacts(github(f"actions/runs/{run_id}/artifacts?per_page=100")["artifacts"], attempt)
        with open(os.environ["GITHUB_OUTPUT"], "a") as output:
            output.write(f"run_id={run_id}\nrun_attempt={attempt}\nartifact_ids={ids}\n")
        print(f"Reusing images from successful PR validation {run_id}")
    elif command == "verify-image":
        image = json.loads(Path(sys.argv[2]).read_text())[0]
        verify_image(image, sys.argv[3], os.environ["SOURCE_TREE"], os.environ["VERSION"])
    elif command == "verify-release":
        image, version, tree = (os.environ[key] for key in ("IMAGE", "VERSION", "SOURCE_TREE"))
        platforms = release_platforms(inspect(f"{image}:{version}", "Manifest"))
        for arch, digest in platforms.items():
            verify_image(inspect(f"{image}@{digest}", "Image"), arch, tree, version)
        print(f"Release {version}: both public platform images match the checked-out source.")
    else:
        raise ValueError(f"Unknown command: {command}")


if __name__ == "__main__":
    main()
