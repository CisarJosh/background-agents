import type { CloudflareSandboxApi } from "../sandbox/cloudflare-api";
import type { SandboxContainerDO } from "./sandbox-container";

// 2 vCPU, 8 GiB memory, 16 GB disk.
export const DEFAULT_SANDBOX_INSTANCE_TYPE = "standard-3";

/** The `cloudflare` sandbox provider's port over the container Durable Object namespace. */
export function createCloudflareSandboxApi(
  namespace: DurableObjectNamespace<SandboxContainerDO>,
  instanceType: string | undefined
): CloudflareSandboxApi {
  const resolvedInstanceType = instanceType?.trim() || DEFAULT_SANDBOX_INSTANCE_TYPE;
  const stub = (sandboxId: string) => namespace.get(namespace.idFromName(sandboxId));
  return {
    start: (sandboxId, request) =>
      stub(sandboxId).start({ ...request, instanceType: resolvedInstanceType }),
    snapshot: (sandboxId) => stub(sandboxId).snapshot(),
    destroy: (sandboxId) => stub(sandboxId).destroy(),
  };
}
