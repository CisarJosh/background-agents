# Cloudflare sandbox image

Builds the sandbox image for the `cloudflare` sandbox provider, checks it, and pushes it to the
Cloudflare account's managed registry.

```bash
npm run sandbox:images -- build --provider cloudflare --output /tmp/cloudflare-image.json
```

The output is a digest-pinned reference:

```
registry.cloudflare.com/<account id>/openinspect-sandbox@sha256:<digest>
```

Set that reference as the image named `sandbox` in the control plane's Wrangler configuration; see
[the provider guide](../../docs/CLOUDFLARE_SANDBOX_PROVIDER.md). Durable Object scheduling accepts
only a digest-pinned image from the account's own registry.

## Where to build

Build on a `linux/amd64` machine. Cloudflare runs only that platform, and the image's own install
check makes system calls that emulation on an Arm machine does not implement, so the build fails
there at its last step. The `cloudflare-sandbox-image` workflow builds on a GitHub-hosted runner.

## Registry credentials

The build needs Docker and a credential that can push to the account's registry:

- With a Wrangler login, or `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, it mints a temporary
  one.
- Otherwise set `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_REGISTRY_PASSWORD` to one minted elsewhere,
  with `wrangler containers registries credentials registry.cloudflare.com --push --json`.
