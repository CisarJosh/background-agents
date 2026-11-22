/** The MCP server over one control-plane client, whatever transport it is then connected to. */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { ControlPlaneError, type ControlPlaneClient } from "./client";
import { TOOLS } from "./tools";

export function createServer(client: ControlPlaneClient): McpServer {
  const server = new McpServer({ name: "open-inspect", version: "0.1.0" });

  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: `${tool.description} Requires a token granted ${tool.requires}.`,
        // The SDK types its schemas with the workspace's hoisted zod, which a test dependency pins
        // below the zod these schemas and shared's are built with. Both are zod 4, converted and
        // validated through the schema objects' own methods, so only the declared types differ;
        // tools.test.ts lists and calls every tool over a real transport to keep that true.
        inputSchema: tool.inputSchema as unknown as ZodRawShapeCompat,
        annotations: {
          readOnlyHint: tool.readOnly,
          // A client uses this to decide how hard to prompt, so a write that replaces what later
          // readers act on has to declare itself even when it is recoverable.
          destructiveHint: tool.destructive ?? false,
          openWorldHint: true,
        },
      },
      async (args: Record<string, unknown>, extra) => {
        try {
          const result = await tool.run(client.withSignal(extra.signal), args);
          return {
            content: [
              {
                type: "text" as const,
                text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
              },
            ],
          };
        } catch (error) {
          // A refusal is information the model can act on, so it is tool output, not a throw.
          const detail =
            error instanceof ControlPlaneError || error instanceof Error
              ? error.message
              : String(error);
          return { content: [{ type: "text" as const, text: detail }], isError: true };
        }
      }
    );
  }

  return server;
}
