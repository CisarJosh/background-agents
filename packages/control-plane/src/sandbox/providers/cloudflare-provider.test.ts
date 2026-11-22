import { describe, expect, it, vi } from "vitest";
import type { CloudflareSandboxApi, CloudflareSandboxStartRequest } from "../cloudflare-api";
import { SandboxProviderError, type CreateSandboxConfig, type RestoreConfig } from "../provider";
import { CloudflareSandboxProvider } from "./cloudflare-provider";

const NOW = 1_700_000_000_000;

function fakeApi(overrides: Partial<CloudflareSandboxApi> = {}) {
  return {
    start: vi.fn(
      overrides.start ?? (async (_sandboxId: string, _request: CloudflareSandboxStartRequest) => {})
    ),
    snapshot: vi.fn(overrides.snapshot ?? (async (): Promise<string | null> => "snapshot-token")),
    destroy: vi.fn(overrides.destroy ?? (async () => {})),
  } satisfies CloudflareSandboxApi;
}

function createProvider(api: CloudflareSandboxApi) {
  return new CloudflareSandboxProvider(api, { scmProvider: "github" }, () => NOW);
}

const createConfig: CreateSandboxConfig = {
  sessionId: "session-1",
  sandboxId: "sandbox-acme-web-app-1700000000000",
  repoOwner: "acme",
  repoName: "web-app",
  controlPlaneUrl: "https://control.example.com/",
  sandboxAuthToken: "sandbox-auth-secret",
  harness: "opencode",
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  userEnvVars: { MY_SECRET: "repo-secret", RESTORED_FROM_SNAPSHOT: "true" },
  timeoutSeconds: 3600,
  codeServerEnabled: true,
};

const restoreConfig: RestoreConfig = { ...createConfig, snapshotImageId: "snapshot-token" };

describe("CloudflareSandboxProvider", () => {
  it("starts a fresh container addressed by the sandbox id, with a finite lifetime", async () => {
    const api = fakeApi();

    const result = await createProvider(api).createSandbox(createConfig);

    const [sandboxId, request] = api.start.mock.calls[0];
    expect(sandboxId).toBe(createConfig.sandboxId);
    expect(request.snapshotId).toBeUndefined();
    expect(request.expiresAtMs).toBe(NOW + 3_600_000);
    expect(request.env).toMatchObject({
      SANDBOX_ID: createConfig.sandboxId,
      SANDBOX_AUTH_TOKEN: "sandbox-auth-secret",
      MY_SECRET: "repo-secret",
      // A repo secret cannot claim a boot mode.
      RESTORED_FROM_SNAPSHOT: "false",
      FROM_REPO_IMAGE: "false",
      SANDBOX_VERSION: expect.stringMatching(/^v\d+/),
    });
    // No preview URLs: code-server is not offered even when enabled.
    expect(request.env.CODE_SERVER_PORT).toBeUndefined();
    expect(result).toEqual({
      sandboxId: createConfig.sandboxId,
      providerObjectId: createConfig.sandboxId,
      createdAt: NOW,
      lifetime: {
        kind: "finite",
        expiresAtMs: NOW + 3_600_000,
        observedAtMs: NOW,
        source: "conservative_start_bound",
      },
    });
  });

  it("restores a new container from a snapshot and tells the runtime so", async () => {
    const api = fakeApi();

    const result = await createProvider(api).restoreFromSnapshot(restoreConfig);

    const [, request] = api.start.mock.calls[0];
    expect(request.snapshotId).toBe("snapshot-token");
    expect(request.env.RESTORED_FROM_SNAPSHOT).toBe("true");
    expect(result).toMatchObject({ success: true, providerObjectId: createConfig.sandboxId });
  });

  it("returns the snapshot token as the image id", async () => {
    const result = await createProvider(fakeApi()).takeSnapshot({
      providerObjectId: "sandbox-1",
      sessionId: "session-1",
      reason: "execution_complete",
    });

    expect(result).toEqual({ success: true, imageId: "snapshot-token" });
  });

  it("fails a snapshot of a container that is no longer running", async () => {
    const api = fakeApi({ snapshot: vi.fn(async () => null) });

    const result = await createProvider(api).takeSnapshot({
      providerObjectId: "sandbox-1",
      sessionId: "session-1",
      reason: "inactivity_timeout",
    });

    expect(result).toEqual({ success: false, error: "Sandbox is not running" });
  });

  it.each(["preserve", "destroy"] as const)(
    "destroys the container on a %s stop",
    async (intent) => {
      const api = fakeApi();

      const result = await createProvider(api).stopSandbox({
        providerObjectId: "sandbox-1",
        sessionId: "session-1",
        reason: "test",
        intent,
      });

      expect(api.destroy).toHaveBeenCalledWith("sandbox-1");
      expect(result).toEqual({ success: true });
    }
  );

  it("treats a start Cloudflare has no instance for yet as transient", async () => {
    const api = fakeApi({
      start: vi.fn(async () => {
        throw new Error(
          "There is no container instance that can be provided to this Durable Object, try again later"
        );
      }),
    });

    const error = await createProvider(api)
      .createSandbox(createConfig)
      .catch((caught: unknown) => caught);

    expect((error as SandboxProviderError).errorType).toBe("transient");
  });

  it("counts any other failed start toward the circuit breaker", async () => {
    const api = fakeApi({
      start: vi.fn(async () => {
        throw new Error("SandboxContainerDO is deployed without a container");
      }),
    });

    const error = await createProvider(api)
      .createSandbox(createConfig)
      .catch((caught: unknown) => caught);

    expect((error as SandboxProviderError).errorType).toBe("permanent");
  });

  it("classifies a failed start for the circuit breaker", async () => {
    const api = fakeApi({
      start: vi.fn(async () => {
        throw new Error("fetch failed");
      }),
    });

    const error = await createProvider(api)
      .createSandbox(createConfig)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SandboxProviderError);
    expect((error as SandboxProviderError).errorType).toBe("transient");
  });
});
