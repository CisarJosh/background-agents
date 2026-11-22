# Cloudflare sandbox provider

Runs each session's sandbox as a Cloudflare Container owned by a Durable Object in the control-plane
Worker. Select it with `SANDBOX_PROVIDER=cloudflare`. It needs the Workers host; the Node host has
no container binding.

## How it works

- `SandboxContainerDO` (`packages/control-plane/src/cloudflare/sandbox-container.ts`) owns one
  container, addressed by the control plane's sandbox id. It starts the container from the image
  named `sandbox`, or from a snapshot, and passes the session's configuration as environment
  variables.
- Work inside a container is not Durable Object activity, so the object sets a one-minute alarm that
  keeps the container alive. The same alarm destroys the container when the session's lifetime ends,
  and clears the object's state if Cloudflare stopped the container without notice.
- A stopped container loses its disk. Sessions survive a stop through filesystem snapshots
  (`supportsSnapshots`, `supportsRestore`), not in-place resume. A snapshot is taken while the
  container keeps running, and restores into a new Durable Object.
- The runtime dials the control plane's public URL for its bridge, Git credentials and model
  credentials, so the container starts with internet access.

Code-server, terminal and VNC previews are not offered. Prebuilt repository images are not
supported.

## Wrangler configuration

Snapshots are only available under Durable Object scheduling, which is also what provides named
images. A container application declared with `image` and `instance_type` starts but refuses
`snapshotContainer()`.

```jsonc
{
  "containers": [
    {
      "class_name": "SandboxContainerDO",
      "scheduling_policy": "durable_object",
      "images": { "sandbox": { "dockerfile": "<path to the sandbox image Dockerfile>" } },
    },
  ],
  "durable_objects": {
    "bindings": [{ "name": "CLOUDFLARE_SANDBOXES", "class_name": "SandboxContainerDO" }],
  },
  "migrations": [{ "tag": "<next tag>", "new_sqlite_classes": ["SandboxContainerDO"] }],
}
```

This is a fragment, not a complete configuration. Merge it into a production Wrangler configuration
that carries the Worker's real name, every binding, variable and cron trigger that
`terraform/environments/production/workers-control-plane.tf` sets, and the existing `SessionDO`
migration ahead of the new one. Deploying the fragment alone would replace the Worker's
configuration and drop the rest.

Containers need the Workers Paid plan. Terraform's Worker module cannot declare a container, so the
control plane has to be deployed with Wrangler when this provider is selected, and taken out of
Terraform's management: the next `terraform apply` would otherwise redeploy it without the
container.

## Settings

| Variable                           | Default      | Meaning                                    |
| ---------------------------------- | ------------ | ------------------------------------------ |
| `SANDBOX_PROVIDER`                 |              | Set to `cloudflare`.                       |
| `CLOUDFLARE_SANDBOX_INSTANCE_TYPE` | `standard-3` | Instance type for every sandbox it starts. |

Set both under `vars` in the Wrangler configuration; the instance type is read by the Worker only.
Terraform's `sandbox_provider` variable does not accept `cloudflare`, and the web app reads its own
copy, so set `NEXT_PUBLIC_SANDBOX_PROVIDER` to `cloudflare` on the web app separately.

## What was measured

Measured on 2026-11-22 with a throwaway Worker on a `standard-4` instance (4 vCPU, 12 GiB memory, 18
GB usable disk), using a Debian image with Node 24, PostgreSQL 16, pgvector and Chromium. Not yet
measured with the real sandbox image.

| Check                                                    | Result                                                 |
| -------------------------------------------------------- | ------------------------------------------------------ |
| PostgreSQL 16 with pgvector 0.8.7, data on the root disk | Starts and serves queries                              |
| Headless Chromium (`--no-sandbox`), page and screenshot  | Works; `/dev/shm` is 64 MB and can be remounted larger |
| Outbound WebSocket to a Worker, HTTPS to GitHub          | Works                                                  |
| `fs.inotify.max_user_watches`                            | 99,321 by default; root can raise it with `sysctl`     |
| Snapshot of a running container, 3.1 GB changed          | 63 seconds; the container keeps running                |
| Second snapshot after a restore, little changed          | 3.7 seconds, 588 KB: snapshots are incremental         |
| Restore into a different Durable Object                  | First command accepted in under a second               |
| Files in `/workspace` and `/tmp` after a restore         | Present                                                |
| PostgreSQL after a restore                               | Not running; starts with crash recovery, data intact   |
| Environment passed to `start()`                          | Reaches the main process, not `exec()` commands        |

## Limits to plan around

- The first start after a deploy can fail with "no container instance that can be provided"; a retry
  a few seconds later succeeds.
- Snapshots are stored as images in the account's registry and cannot be deleted by the account.
  They expire 30 days after they were created or last restored.
- A snapshot holds the whole container disk, including the Git credential helper's cache and
  anything a setup script or the agent wrote. Because it cannot be deleted, treat it as sensitive
  and rotate any long-lived credential that reached the disk. See
  [credential delivery and snapshots](AUTH.md#credential-delivery-and-snapshots).
- A snapshot restores only onto the image it was taken from, and not after it expires. When a
  restore fails, the control plane does not substitute a clean sandbox: the session is held with its
  snapshot reference, and its owner chooses Discard to start fresh from the pushed branch, or
  Restore to retry.
- The largest instance is 4 vCPU, 12 GiB memory and 20 GB disk, shared by the image, the checkout,
  dependencies and any database.
- Whatever a repository's `.openinspect/start.sh` starts, such as PostgreSQL, has to be started
  again after a restore: a snapshot holds the disk, not processes. The runtime runs `start.sh` on
  every boot.
