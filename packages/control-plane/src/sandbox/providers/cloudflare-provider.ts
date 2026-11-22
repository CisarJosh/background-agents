import { supportsConfigurableSandboxTimeout } from "@open-inspect/shared/types/integrations";
import { createLogger } from "../../logger";
import type { SourceControlProviderName } from "../../source-control";
import type { CloudflareSandboxApi } from "../cloudflare-api";
import {
  DEFAULT_SANDBOX_TIMEOUT_SECONDS,
  SandboxProviderError,
  type CreateSandboxConfig,
  type CreateSandboxResult,
  type RestoreConfig,
  type RestoreResult,
  type SandboxLifetime,
  type SandboxProvider,
  type SandboxProviderCapabilities,
  type SnapshotConfig,
  type SnapshotResult,
  type StopConfig,
  type StopResult,
} from "../provider";
import { SANDBOX_RUNTIME_VERSION } from "../runtime-manifest";
import {
  buildSandboxEnvVars,
  DEFERRED_START_ENV_VAR,
  IMAGE_BUILD_MODE_ENV_VAR,
  scmCloneIdentity,
} from "../sandbox-env";
import { resolveSandboxPortPlan } from "./port-resolution";

const log = createLogger("cloudflare-provider");

const MS_PER_SECOND = 1000;

export interface CloudflareProviderConfig {
  scmProvider: SourceControlProviderName;
}

/**
 * Sandboxes as Cloudflare containers. A stopped container loses its disk, so
 * sessions survive a stop through filesystem snapshots, not in-place resume.
 */
export class CloudflareSandboxProvider implements SandboxProvider {
  readonly name = "cloudflare";

  readonly capabilities: SandboxProviderCapabilities = {
    supportsSandboxTimeout: supportsConfigurableSandboxTimeout(this.name),
    supportsSnapshots: true,
    supportsRestore: true,
    supportsPersistentResume: false,
    supportsExplicitStop: true,
  };

  constructor(
    private readonly api: CloudflareSandboxApi,
    private readonly config: CloudflareProviderConfig,
    private readonly now: () => number = Date.now
  ) {}

  async createSandbox(config: CreateSandboxConfig): Promise<CreateSandboxResult> {
    const createdAt = this.now();
    const lifetime = await this.start(config, createdAt);
    return { sandboxId: config.sandboxId, providerObjectId: config.sandboxId, createdAt, lifetime };
  }

  async restoreFromSnapshot(config: RestoreConfig): Promise<RestoreResult> {
    const lifetime = await this.start(config, this.now(), config.snapshotImageId);
    return {
      success: true,
      sandboxId: config.sandboxId,
      providerObjectId: config.sandboxId,
      lifetime,
    };
  }

  async takeSnapshot(config: SnapshotConfig): Promise<SnapshotResult> {
    try {
      const snapshotId = await this.api.snapshot(config.providerObjectId);
      if (snapshotId === null) return { success: false, error: "Sandbox is not running" };
      return { success: true, imageId: snapshotId };
    } catch (error) {
      throw classifyError("Failed to snapshot Cloudflare sandbox", error);
    }
  }

  // Nothing of a stopped container is resumable, so preserving and destroying are the same stop.
  async stopSandbox(config: StopConfig): Promise<StopResult> {
    try {
      await this.api.destroy(config.providerObjectId);
      return { success: true };
    } catch (error) {
      throw classifyError("Failed to stop Cloudflare sandbox", error);
    }
  }

  private async start(
    config: CreateSandboxConfig | RestoreConfig,
    startAtMs: number,
    snapshotId?: string
  ): Promise<Extract<SandboxLifetime, { kind: "finite" }>> {
    const expiresAtMs =
      startAtMs + (config.timeoutSeconds ?? DEFAULT_SANDBOX_TIMEOUT_SECONDS) * MS_PER_SECOND;
    try {
      await this.api.start(config.sandboxId, {
        env: this.buildEnvVars(config, snapshotId !== undefined),
        expiresAtMs,
        snapshotId,
      });
    } catch (error) {
      throw classifyError("Failed to start Cloudflare sandbox", error);
    }
    log.info("cloudflare.container_started", {
      session_id: config.sessionId,
      sandbox_id: config.sandboxId,
      restored_from_snapshot: snapshotId !== undefined,
    });
    // An alarm ends the container at this time; that is a bound, not proof it has stopped.
    return {
      kind: "finite",
      expiresAtMs,
      observedAtMs: this.now(),
      source: "conservative_start_bound",
    };
  }

  private buildEnvVars(
    config: CreateSandboxConfig | RestoreConfig,
    restoredFromSnapshot: boolean
  ): Record<string, string> {
    const envVars = buildSandboxEnvVars(config, {
      scmIdentity: scmCloneIdentity(this.config.scmProvider),
      portPlan: resolveSandboxPortPlan({ codeServer: false, terminal: false, vnc: false }, {}),
      emitDisabledTerminalEnv: true,
    });
    Object.assign(envVars, {
      [DEFERRED_START_ENV_VAR]: "false",
      [IMAGE_BUILD_MODE_ENV_VAR]: "false",
      RESTORED_FROM_SNAPSHOT: String(restoredFromSnapshot),
      FROM_REPO_IMAGE: "false",
      // The image does not bake its runtime version, and the control plane gates features on it.
      SANDBOX_VERSION: SANDBOX_RUNTIME_VERSION,
    });
    return envVars;
  }
}

// Cloudflare marks errors worth retrying on the error object, and answers a start it has no
// instance for yet (routine just after a deploy) with a message that says so.
function isRetryable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const flags = error as Error & { retryable?: boolean; overloaded?: boolean };
  return (
    flags.retryable === true ||
    flags.overloaded === true ||
    /no container instance/i.test(error.message)
  );
}

function classifyError(message: string, error: unknown): SandboxProviderError {
  if (error instanceof SandboxProviderError) return error;
  if (isRetryable(error)) {
    return new SandboxProviderError(`${message}: ${String(error)}`, "transient", error as Error);
  }
  return SandboxProviderError.fromFetchError(`${message}: ${String(error)}`, error);
}

export function createCloudflareProvider(
  api: CloudflareSandboxApi,
  config: CloudflareProviderConfig
): CloudflareSandboxProvider {
  return new CloudflareSandboxProvider(api, config);
}
