import { DurableObject } from "cloudflare:workers";
import type { CloudflareSandboxStartRequest } from "../sandbox/cloudflare-api";

// Matches the runtime's install path in packages/sandbox-images.
const ENTRYPOINT = ["/opt/openinspect/python/bin/python", "-m", "sandbox_runtime.entrypoint"];
const KEEPALIVE_INTERVAL_MS = 60_000;
// Survives a few late alarms; the alarm, not this, decides when a healthy sandbox ends.
const INACTIVITY_TIMEOUT_MS = 5 * KEEPALIVE_INTERVAL_MS;
const EXPIRES_AT_KEY = "expiresAtMs";
// The key of the sandbox image under `containers[].images` in the Worker's Wrangler configuration.
const IMAGE_NAME = "sandbox";

export interface SandboxContainerStartRequest extends CloudflareSandboxStartRequest {
  /** A named Cloudflare instance type, such as "standard-3". */
  instanceType: string;
}

// The installed @cloudflare/workers-types predates named images and the `image` and `instance`
// start options; drop these two types once it is on 5.x.
type SandboxContainer = Container & { images?: Record<string, string> };
type StartOptions = {
  entrypoint: string[];
  enableInternet: boolean;
  env: Record<string, string>;
  instance: string;
} & ({ image: string } | { containerSnapshot: { id: string } });

/** Owns one sandbox container: starts it, keeps it alive until its lifetime ends, snapshots and destroys it. */
export class SandboxContainerDO extends DurableObject {
  async start(request: SandboxContainerStartRequest): Promise<void> {
    const container = this.container();
    if (container.running) return;
    const options: StartOptions = {
      entrypoint: ENTRYPOINT,
      // The runtime dials the control plane's public URL for its bridge and credentials.
      enableInternet: true,
      env: request.env,
      instance: request.instanceType,
      ...(request.snapshotId
        ? { containerSnapshot: { id: request.snapshotId } }
        : { image: this.image(container) }),
    };
    container.start(options as ContainerStartupOptions);
    try {
      await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
      await this.ctx.storage.put(EXPIRES_AT_KEY, request.expiresAtMs);
      await this.ctx.storage.setAlarm(Date.now() + KEEPALIVE_INTERVAL_MS);
    } catch (error) {
      // The caller is told the start failed, so nothing would ever stop this container.
      await this.destroy().catch(() => {});
      throw error;
    }
  }

  async snapshot(): Promise<string | null> {
    const container = this.container();
    if (!container.running) return null;
    return (await container.snapshotContainer({})).id;
  }

  async destroy(): Promise<void> {
    const container = this.container();
    if (container.running) await container.destroy();
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  // Work inside a container is not Durable Object activity, so this alarm is what keeps a
  // sandbox running, and what notices one the platform stopped without telling anyone.
  async alarm(): Promise<void> {
    const expiresAtMs = await this.ctx.storage.get<number>(EXPIRES_AT_KEY);
    const now = Date.now();
    if (this.container().running && expiresAtMs !== undefined && now < expiresAtMs) {
      await this.ctx.storage.setAlarm(Math.min(now + KEEPALIVE_INTERVAL_MS, expiresAtMs));
    } else {
      await this.destroy();
    }
  }

  private container(): SandboxContainer {
    if (!this.ctx.container) {
      throw new Error("SandboxContainerDO is deployed without a container");
    }
    return this.ctx.container;
  }

  private image(container: SandboxContainer): string {
    const image = container.images?.[IMAGE_NAME];
    if (!image) {
      // Snapshots need Durable Object scheduling, which is also what provides named images.
      throw new Error(
        `SandboxContainerDO needs scheduling_policy "durable_object" and an image named "${IMAGE_NAME}"`
      );
    }
    return image;
  }
}
