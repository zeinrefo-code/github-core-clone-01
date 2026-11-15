// The MCP endpoint (POST /mcp): JSON-RPC 2.0 over Streamable HTTP, with the
// forge's tools acting on the same store as REST and git. Implemented in
// full in mcp.ts proper; this placeholder keeps the server whole while the
// surface is being built.

import type { ServerResponse } from 'node:http';
import type { Forge } from './forge.ts';

type SendJson = (res: ServerResponse, status: number, body: unknown, headers?: Readonly<Record<string, string>>) => void;

export async function handleMCP(forge: Forge, body: Buffer, res: ServerResponse, sendJson: SendJson): Promise<void> {
  void forge;
  void body;
  sendJson(res, 200, { jsonrpc: '2.0', id: null, error: { code: -32601, message: 'not implemented yet' } });
}
