import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "./worker";
import { TOOLS } from "./tools";

const ENV = { CONTROL_PLANE_URL: "https://control.example.com" };
const TOKEN = `oi_pat_${"a".repeat(64)}`;

afterEach(() => vi.unstubAllGlobals());

function mcpRequest(body: unknown, token?: string, path = "/mcp"): Request {
  return new Request(`https://mcp.example.com${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("remote MCP worker", () => {
  it("refuses a request with no token, or one that is not a personal access token", async () => {
    const list = { jsonrpc: "2.0", id: 1, method: "tools/list" };

    for (const token of [undefined, "ghp_not-one-of-ours", `oi_pat_${"a".repeat(63)}`]) {
      const response = await worker.fetch(mcpRequest(list, token), ENV);
      expect(response.status).toBe(401);
      expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
    }
  });

  it("serves nothing outside the MCP path", async () => {
    const response = await worker.fetch(mcpRequest({}, TOKEN, "/"), ENV);
    expect(response.status).toBe(404);
  });

  it("lists every tool over Streamable HTTP for a caller presenting a token", async () => {
    const response = await worker.fetch(
      mcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" }, TOKEN),
      ENV
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: { tools: Array<{ name: string }> } };
    expect(body.result.tools.map((entry) => entry.name).sort()).toEqual(
      TOOLS.map((entry) => entry.name).sort()
    );
  });

  it("calls the control plane it was configured with, as the caller's own token", async () => {
    const fetchMock = vi.fn(async () => Response.json({ sessions: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const call = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "list_sessions", arguments: {} },
    };

    const response = await worker.fetch(mcpRequest(call, TOKEN), ENV);

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url.startsWith(`${ENV.CONTROL_PLANE_URL}/sessions`)).toBe(true);
    expect(new Headers(init.headers).get("Authorization")).toBe(`Bearer ${TOKEN}`);
  });

  it("refuses a batch before anything reaches the control plane", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const call = { jsonrpc: "2.0", method: "tools/call", params: { name: "list_sessions" } };

    const response = await worker.fetch(
      mcpRequest(
        [
          { ...call, id: 1 },
          { ...call, id: 2 },
        ],
        TOKEN
      ),
      ENV
    );

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers only POST, so no event stream is ever held open", async () => {
    const request = new Request("https://mcp.example.com/mcp", {
      headers: { Accept: "text/event-stream", Authorization: `Bearer ${TOKEN}` },
    });

    const response = await worker.fetch(request, ENV);

    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("POST");
  });
});
