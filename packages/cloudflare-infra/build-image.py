#!/usr/bin/env python3
"""Build the sandbox image for Cloudflare Containers and push it to the account's registry."""

from __future__ import annotations

import json
import os
import platform
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "packages/sandbox-images/src"))

from sandbox_images.bundle import pack_bundle  # noqa: E402
from sandbox_images.native import write_build_result  # noqa: E402

IMAGE_NAME = "openinspect-sandbox"
REGISTRY = "registry.cloudflare.com"


def registry_credentials() -> dict[str, str]:
    """A push credential for the account's registry: the caller's, or one minted through Wrangler."""
    account = os.environ.get("CLOUDFLARE_ACCOUNT_ID")
    password = os.environ.get("CLOUDFLARE_REGISTRY_PASSWORD")
    if account and password:
        username = os.environ.get("CLOUDFLARE_REGISTRY_USERNAME", "v1")
        return {"account_id": account, "username": username, "password": password}
    wrangler = ROOT / "node_modules/.bin/wrangler"
    minted = subprocess.run(
        [
            str(wrangler) if wrangler.exists() else "wrangler",
            *("containers", "registries", "credentials", REGISTRY, "--push", "--json"),
        ],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(minted.stdout)


def main() -> None:
    bundle = pack_bundle(ROOT, "cloudflare", ROOT / ".cache/sandbox-images")
    tag = f"{IMAGE_NAME}:{bundle.plan['buildHash'][:12]}"
    # Cloudflare runs linux/amd64 only. The build's last step is the image's own install check,
    # which needs a real amd64 kernel: emulation lacks system calls it makes.
    dockerfile = ROOT / "packages/sandbox-images/Dockerfile"
    subprocess.run(
        [
            *("docker", "build", "--platform", "linux/amd64"),
            *("-f", str(dockerfile), "-t", tag, str(bundle.directory)),
        ],
        check=True,
    )
    # The image's default command checks its services; it is only meaningful without emulation.
    if platform.machine() in ("x86_64", "AMD64"):
        subprocess.run(["docker", "run", "--rm", "--platform", "linux/amd64", tag], check=True)

    # Without a registry credential on this machine, hand the checked image over as a file.
    archive = os.environ.get("OPENINSPECT_IMAGE_ARCHIVE")
    if archive:
        subprocess.run(["docker", "save", "--output", archive, tag], check=True)
        write_build_result(tag)
        return

    credentials = registry_credentials()
    remote = f"{REGISTRY}/{credentials['account_id']}/{tag}"
    subprocess.run(
        ["docker", "login", REGISTRY, "--username", credentials["username"], "--password-stdin"],
        input=credentials["password"],
        text=True,
        check=True,
    )
    subprocess.run(["docker", "tag", tag, remote], check=True)
    subprocess.run(["docker", "push", remote], check=True)
    digests = json.loads(
        subprocess.run(
            ["docker", "image", "inspect", "--format", "{{json .RepoDigests}}", remote],
            check=True,
            capture_output=True,
            text=True,
        ).stdout
    )
    references = [digest for digest in digests if digest.startswith(f"{REGISTRY}/")]
    if not references:
        raise RuntimeError("The pushed image has no Cloudflare registry digest")
    # Durable Object scheduling only accepts a digest-pinned image from the account's registry.
    write_build_result(references[0])


if __name__ == "__main__":
    main()
