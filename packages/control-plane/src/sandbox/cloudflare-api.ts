export interface CloudflareSandboxStartRequest {
  env: Record<string, string>;
  /** When the container's owner destroys it, whatever the session is doing. */
  expiresAtMs: number;
  /** An id from `snapshot()`; the container boots from that filesystem instead of the image. */
  snapshotId?: string;
}

/** One Cloudflare container per sandbox, addressed by the control plane's sandbox id. */
export interface CloudflareSandboxApi {
  /** Starting a sandbox that is already running is a no-op. */
  start(sandboxId: string, request: CloudflareSandboxStartRequest): Promise<void>;
  /** Snapshot the running container's filesystem without stopping it; null when it is not running. */
  snapshot(sandboxId: string): Promise<string | null>;
  /** Destroying a sandbox that is already gone succeeds. */
  destroy(sandboxId: string): Promise<void>;
}
