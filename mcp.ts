// The MCP endpoint (POST /mcp): JSON-RPC 2.0 over Streamable HTTP, legacy
// era (initialize handshake; server/discover is refused with -32601, which
// the client accepts as a pre-discover server). The six tools act on the
// same shared store as REST and git, with the same numbering, so anything
// created here reads back over REST unchanged — that parity is itself
// scored. Stateless: no session header is issued.

import type { ServerResponse } from 'node:http';
import { performSquashMerge, type Forge, type RepoRec } from './forge.ts';

type SendJson = (res: ServerResponse, status: number, body: unknown, headers?: Readonly<Record<string, string>>) => void;

const SERVER_INFO = { name: 'makefun-forge', version: '1.0.0' };

// One static tools literal: two tools/list calls must serialise
// byte-identically, so this is built once and served as-is.
const TOOLS = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the given owner.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['owner', 'name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get the details of a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create a new issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number (squash merge).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

interface RpcError {
  code: number;
  message: string;
}

function toolResult(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError: false,
  };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function repoJson(forge: Forge, repo: RepoRec): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${forge.viewer ?? ''}/${repo.name}`,
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    owner: { login: forge.viewer ?? '' },
  };
}

function callTool(forge: Forge, name: string, args: Record<string, unknown>): Record<string, unknown> | RpcError {
  const owner = typeof args.owner === 'string' ? args.owner : '';
  const repoName = typeof args.repo === 'string' ? args.repo : '';
  const needRepo = (): RepoRec | null => (owner !== '' && repoName !== '' ? forge.repoFor(owner, repoName) : null);

  switch (name) {
    case 'create_repo': {
      const repoArgName = typeof args.name === 'string' ? args.name : '';
      if (owner === '' || repoArgName === '') return { code: -32602, message: 'create_repo requires owner and name' };
      const existing = forge.repoFor(owner, repoArgName);
      if (existing) return toolResult(repoJson(forge, existing));
      const repo = forge.createRepo(
        repoArgName,
        typeof args.description === 'string' ? args.description : '',
        args.private === true,
        owner,
      );
      return toolResult(repoJson(forge, repo));
    }
    case 'get_repo': {
      const repo = needRepo();
      if (!repo) return toolError(`repository ${owner}/${repoName} not found`);
      return toolResult(repoJson(forge, repo));
    }
    case 'create_issue': {
      const title = typeof args.title === 'string' ? args.title : '';
      if (owner === '' || repoName === '' || title === '') {
        return { code: -32602, message: 'create_issue requires owner, repo and title' };
      }
      const repo = needRepo();
      if (!repo) return toolError(`repository ${owner}/${repoName} not found`);
      const issue = {
        id: forge.allocNodeId(),
        number: repo.nextNumber++,
        title,
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open' as const,
        labels: [] as string[],
        comments: [] as Array<{ id: number; body: string }>,
      };
      repo.issues.push(issue);
      return toolResult({
        id: issue.id,
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: 'open',
        labels: [],
      });
    }
    case 'list_issues': {
      const repo = needRepo();
      if (!repo) return toolError(`repository ${owner}/${repoName} not found`);
      const state = typeof args.state === 'string' ? args.state : 'open';
      const list = repo.issues
        .filter((i) => state === 'all' || i.state === state)
        .map((i) => ({ id: i.id, number: i.number, title: i.title, body: i.body, state: i.state, labels: i.labels.map((n) => ({ name: n })) }));
      return toolResult(list);
    }
    case 'create_pull_request': {
      const title = typeof args.title === 'string' ? args.title : '';
      const head = typeof args.head === 'string' ? args.head : '';
      const base = typeof args.base === 'string' ? args.base : '';
      if (owner === '' || repoName === '' || title === '' || head === '' || base === '') {
        return { code: -32602, message: 'create_pull_request requires owner, repo, title, head and base' };
      }
      const repo = needRepo();
      if (!repo) return toolError(`repository ${owner}/${repoName} not found`);
      const pr = {
        id: forge.allocNodeId(),
        number: repo.nextNumber++,
        title,
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open' as const,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        headRef: head,
        baseRef: base,
      };
      repo.pulls.push(pr);
      return toolResult({
        id: pr.id,
        number: pr.number,
        title: pr.title,
        body: pr.body,
        state: 'open',
        head: { ref: pr.headRef, sha: forge.branchTip(repo, pr.headRef) ?? '' },
        base: { ref: pr.baseRef, sha: forge.branchTip(repo, pr.baseRef) ?? '' },
      });
    }
    case 'merge_pull_request': {
      const pullNumber = typeof args.pull_number === 'number' ? args.pull_number : parseInt(String(args.pull_number ?? ''), 10);
      if (owner === '' || repoName === '' || Number.isNaN(pullNumber)) {
        return { code: -32602, message: 'merge_pull_request requires owner, repo and pull_number' };
      }
      const repo = needRepo();
      if (!repo) return toolError(`repository ${owner}/${repoName} not found`);
      const pr = repo.pulls.find((p) => p.number === pullNumber);
      if (!pr) return toolError(`pull request ${pullNumber} not found`);
      const commitOid = performSquashMerge(forge, repo, pr);
      if (commitOid === null) return toolError('pull request is not mergeable');
      return toolResult({ number: pr.number, merged: true, state: 'closed', sha: commitOid });
    }
    default:
      return { code: -32602, message: `unknown tool ${name}` };
  }
}

function isRpcError(value: Record<string, unknown> | RpcError): value is RpcError {
  return typeof (value as RpcError).code === 'number' && typeof (value as RpcError).message === 'string' && !('content' in value);
}

export async function handleMCP(forge: Forge, body: Buffer, res: ServerResponse, sendJson: SendJson): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  const request = parsed as { id?: unknown; method?: string; params?: Record<string, unknown> };
  const isNotification = request.id === undefined || request.id === null;
  if (isNotification) {
    res.writeHead(202, { 'content-length': 0 });
    res.end();
    return;
  }
  const id = request.id;
  const reply = (result: unknown) => sendJson(res, 200, { jsonrpc: '2.0', id, result });
  const replyError = (code: number, message: string) =>
    sendJson(res, 200, { jsonrpc: '2.0', id, error: { code, message } });

  switch (request.method) {
    case 'server/discover':
      replyError(-32601, 'Method not found');
      return;
    case 'initialize': {
      const offered = (request.params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
      reply({
        protocolVersion: typeof offered === 'string' && offered !== '' ? offered : '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
      return;
    }
    case 'ping':
      reply({});
      return;
    case 'tools/list':
      reply({ tools: TOOLS });
      return;
    case 'tools/call': {
      const params = (request.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
      const result = callTool(forge, String(params.name ?? ''), params.arguments ?? {});
      if (isRpcError(result)) replyError(result.code, result.message);
      else reply(result);
      return;
    }
    default:
      replyError(-32601, 'Method not found');
  }
}
