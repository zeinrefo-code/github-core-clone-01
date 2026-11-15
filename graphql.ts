// GraphQL v4 (POST /api/graphql): the executor for the documents gh and
// github-mcp-server send. Implemented in full in graphql.ts proper; this
// placeholder keeps the server whole while the surface is being built.

import type { ServerResponse } from 'node:http';
import type { Forge } from './forge.ts';

type SendJson = (res: ServerResponse, status: number, body: unknown, headers?: Readonly<Record<string, string>>) => void;

export async function handleGraphQL(forge: Forge, body: Buffer, res: ServerResponse, sendJson: SendJson): Promise<void> {
  void forge;
  void body;
  sendJson(res, 200, { data: null, errors: [{ message: 'not implemented yet' }] });
}
