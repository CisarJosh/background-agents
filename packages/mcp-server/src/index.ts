/**
 * MCP server over the Open-Inspect control plane.
 *
 * Runs locally over stdio and authenticates with a personal access token, so every request is
 * attributable to the user who issued it and bounded by the permissions the token was granted.
 * The control plane enforces that bound; this server only presents the tools.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ControlPlaneClient } from "./client";
import { createServer } from "./server";

export { createServer };

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    // stderr, not stdout: stdout is the MCP transport and any stray byte there corrupts it.
    console.error(`open-inspect-mcp: ${name} is required`);
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  let client: ControlPlaneClient;
  try {
    client = new ControlPlaneClient({
      baseUrl: requireEnv("OPEN_INSPECT_CONTROL_PLANE_URL"),
      token: requireEnv("OPEN_INSPECT_TOKEN"),
    });
  } catch (error) {
    console.error(`open-inspect-mcp: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  await createServer(client).connect(new StdioServerTransport());
}

// Imported for createServer alone by the tests, which set VITEST.
if (!process.env.VITEST) {
  main().catch((error: unknown) => {
    console.error("open-inspect-mcp: fatal:", error);
    process.exit(1);
  });
}
