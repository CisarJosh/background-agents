/**
 * The same MCP server, served over Streamable HTTP from a Cloudflare Worker, for clients that are
 * not on the machine holding the token.
 *
 * The caller presents its own personal access token as a bearer credential and this Worker passes
 * it through: it holds no token of its own, stores nothing, and the control plane decides what the
 * token may do, exactly as it does for the stdio server.
 */

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isPersonalAccessTokenFormat } from "@open-inspect/shared/types/personal-access-tokens";
import { ControlPlaneClient } from "./client";
import { createServer } from "./server";

interface Env {
  CONTROL_PLANE_URL: string;
}

const MCP_PATH = "/mcp";
/** Longest request body read, matching the MCP SDK's own limit. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

function unauthorized(): Response {
  return new Response("A personal access token is required as a bearer credential", {
    status: 401,
    headers: { "WWW-Authenticate": "Bearer" },
  });
}

function bearerToken(request: Request): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get("Authorization") ?? "");
  return match ? match[1] : null;
}

function rpcError(status: number, code: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", error: { code, message }, id: null }, { status });
}

/** The body as text, or null once it passes the cap. */
async function readCapped(request: Request): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(await new Blob(chunks).arrayBuffer());
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname !== MCP_PATH) {
      return new Response("Not found", { status: 404 });
    }
    // Stateless, so there is no stream to open with GET and no session to end with DELETE; the
    // SDK would otherwise hold a GET open as an event stream.
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
    }
    const token = bearerToken(request);
    // Only the shape is checked here; the control plane verifies the token on every call.
    if (!token || !isPersonalAccessTokenFormat(token)) return unauthorized();

    const text = await readCapped(request);
    if (text === null) return rpcError(413, -32600, "Request body is too large");
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      return rpcError(400, -32700, "Request body is not JSON");
    }
    // A batch would let one request, sent before any token has been verified, become a hundred
    // calls to the control plane.
    if (Array.isArray(message)) return rpcError(400, -32600, "Batch requests are not supported");

    // One server and one client per request, so nothing outlives the caller's token.
    const client = new ControlPlaneClient({ baseUrl: env.CONTROL_PLANE_URL, token });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await createServer(client).connect(transport);
    return transport.handleRequest(request, { parsedBody: message });
  },
};
