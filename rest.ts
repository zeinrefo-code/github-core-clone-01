// REST v3: the /api/v3 surface — repos, refs, branches, commits, contents
// (whose writes are real git commits), labels, issues, comments and pull
// requests with squash merges. Everything serialises from the shared store,
// so REST reads see git pushes and MCP writes exactly as they happened.
//
// The contract implemented here is the suite's endpoint table: status codes
// (201 creates, 204 delete, 409 stale contents sha, 422 unknown label, 405
// merge conflict), {message} error bodies, Link pagination on the repo list,
// and an X-GitHub-Request-Id on every reply.

import type { ServerResponse } from 'node:http';
import {
  ZERO_OID,
  buildCommitData,
  flattenTree,
  lookupPath,
  mergeBase,
  parseCommit,
  parseTree,
  updateTree,
} from './gitstore.ts';
import type { Forge, IssueRec, PullRec, RepoRec } from './forge.ts';
import { performSquashMerge } from './forge.ts';

type SendJson = (res: ServerResponse, status: number, body: unknown, headers?: Readonly<Record<string, string>>) => void;

interface Ctx {
  forge: Forge;
  res: ServerResponse;
  sendJson: SendJson;
  baseUrl: string;
}

function j(ctx: Ctx, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  ctx.sendJson(ctx.res, status, body, { 'x-github-request-id': ctx.forge.requestId(), ...headers });
}

function fail(ctx: Ctx, status: number, message: string): void {
  j(ctx, status, { message });
}

/** Parse a JSON request body; on malformed JSON, answer 400 and return undefined. */
function jsonBody(ctx: Ctx, body: Buffer): Record<string, unknown> | undefined {
  if (body.length === 0) return {};
  try {
    const parsed = JSON.parse(body.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    fail(ctx, 400, 'Malformed JSON in request body');
    return undefined;
  }
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

function issueJson(repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? 'ededed' })),
    comments: issue.comments.length,
  };
}

function pullJson(forge: Forge, repo: RepoRec, pr: PullRec): Record<string, unknown> {
  return {
    id: pr.id,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    head: { ref: pr.headRef, sha: forge.branchTip(repo, pr.headRef) ?? ZERO_OID },
    base: { ref: pr.baseRef, sha: forge.branchTip(repo, pr.baseRef) ?? ZERO_OID },
  };
}

/** Commit oids newest-first from a tip: depth-first, parents in order, no repeats. */
function listCommits(forge: Forge, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const obj = forge.store.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    seen.add(oid);
    out.push(oid);
    const parents = parseCommit(obj.data).parents;
    for (let i = parents.length - 1; i >= 0; i--) stack.push(parents[i]);
  }
  return out;
}

/** Make a commit on a branch from a new root tree; returns the commit oid. */
function commitOnBranch(
  forge: Forge,
  repo: RepoRec,
  branch: string,
  treeOid: string,
  message: string,
): string {
  const tip = forge.branchTip(repo, branch);
  const data = buildCommitData({
    tree: treeOid,
    parents: tip ? [tip] : [],
    message,
    authorLine: forge.authorLine(),
  });
  const oid = forge.store.store('commit', data);
  forge.setBranch(repo, branch, oid);
  return oid;
}

// ---------------------------------------------------------------------------
// Contents (spec §3.4): writes are commits on the shared object store.
// ---------------------------------------------------------------------------

function contentsPut(ctx: Ctx, repo: RepoRec, path: string, body: Buffer): void {
  const input = jsonBody(ctx, body);
  if (!input) return;
  const message = typeof input.message === 'string' ? input.message : `Update ${path}`;
  const branch = typeof input.branch === 'string' ? input.branch : repo.defaultBranch;
  const content = typeof input.content === 'string' ? Buffer.from(input.content, 'base64') : Buffer.alloc(0);
  const tip = forge_tip(ctx, repo, branch);
  const tipTree = tip ? parseCommit(ctx.forge.store.get(tip)?.data ?? Buffer.alloc(0)).tree : null;
  const parts = path.split('/').filter((p) => p !== '');
  const existing = tipTree ? lookupPath(ctx.forge.store, tipTree, parts) : null;
  if (existing && typeof input.sha === 'string' && input.sha !== existing.oid) {
    fail(ctx, 409, 'SHA does not match the current file');
    return;
  }
  const blobOid = ctx.forge.store.store('blob', content);
  const newTree = updateTree(ctx.forge.store, tipTree, parts, blobOid, existing?.mode ?? '100644');
  const commitOid = commitOnBranch(ctx.forge, repo, branch, newTree, message);
  j(ctx, existing ? 200 : 201, {
    content: { sha: blobOid, encoding: 'base64', name: parts[parts.length - 1] ?? path, path },
    commit: { sha: commitOid },
  });
}

function forge_tip(ctx: Ctx, repo: RepoRec, branch: string): string | null {
  return ctx.forge.branchTip(repo, branch);
}

function contentsGet(ctx: Ctx, repo: RepoRec, path: string, params: URLSearchParams): void {
  const ref = params.get('ref') ?? repo.defaultBranch;
  const tip = ctx.forge.branchTip(repo, ref) ?? (ctx.forge.store.has(ref) ? ref : null);
  if (!tip) {
    fail(ctx, 404, 'Not Found');
    return;
  }
  const commitObj = ctx.forge.store.get(tip);
  if (!commitObj || commitObj.type !== 'commit') {
    fail(ctx, 404, 'Not Found');
    return;
  }
  const tree = parseCommit(commitObj.data).tree;
  const parts = path.split('/').filter((p) => p !== '');
  if (parts.length === 0) {
    j(ctx, 200, dirListing(ctx, tree, ''));
    return;
  }
  const found = lookupPath(ctx.forge.store, tree, parts);
  if (!found) {
    fail(ctx, 404, 'Not Found');
    return;
  }
  if (found.mode === '40000') {
    j(ctx, 200, dirListing(ctx, found.oid, path));
    return;
  }
  const blob = ctx.forge.store.get(found.oid);
  if (!blob) {
    fail(ctx, 404, 'Not Found');
    return;
  }
  j(ctx, 200, {
    type: 'file',
    encoding: 'base64',
    content: blob.data.toString('base64'),
    sha: found.oid,
    size: blob.data.length,
    name: parts[parts.length - 1],
    path,
  });
}

function dirListing(ctx: Ctx, treeOid: string, basePath: string): Array<Record<string, unknown>> {
  const obj = ctx.forge.store.get(treeOid);
  if (!obj || obj.type !== 'tree') return [];
  return parseTree(obj.data).map((entry) => ({
    type: entry.mode === '40000' ? 'dir' : 'file',
    name: entry.name,
    path: basePath === '' ? entry.name : `${basePath}/${entry.name}`,
    sha: entry.oid,
  }));
}

function contentsDelete(ctx: Ctx, repo: RepoRec, path: string, body: Buffer): void {
  const input = jsonBody(ctx, body);
  if (!input) return;
  const message = typeof input.message === 'string' ? input.message : `Delete ${path}`;
  const branch = typeof input.branch === 'string' ? input.branch : repo.defaultBranch;
  const tip = ctx.forge.branchTip(repo, branch);
  if (!tip) {
    fail(ctx, 404, 'Not Found');
    return;
  }
  const tipTree = parseCommit(ctx.forge.store.get(tip)?.data ?? Buffer.alloc(0)).tree;
  const parts = path.split('/').filter((p) => p !== '');
  if (!lookupPath(ctx.forge.store, tipTree, parts)) {
    fail(ctx, 404, 'Not Found');
    return;
  }
  const newTree = updateTree(ctx.forge.store, tipTree, parts, null);
  const commitOid = commitOnBranch(ctx.forge, repo, branch, newTree, message);
  j(ctx, 200, { commit: { sha: commitOid } });
}

// ---------------------------------------------------------------------------
// Issues and comments
// ---------------------------------------------------------------------------

function issueCreate(ctx: Ctx, repo: RepoRec, body: Buffer): void {
  const input = jsonBody(ctx, body);
  if (!input) return;
  const labels = Array.isArray(input.labels) ? input.labels.map((l) => String(l)) : [];
  for (const name of labels) {
    if (!repo.labels.has(name)) {
      fail(ctx, 422, `Label "${name}" does not exist on this repository`);
      return;
    }
  }
  const issue: IssueRec = {
    id: ctx.forge.allocNodeId(),
    number: repo.nextNumber++,
    title: typeof input.title === 'string' ? input.title : '',
    body: typeof input.body === 'string' ? input.body : '',
    state: 'open',
    labels,
    comments: [],
  };
  repo.issues.push(issue);
  j(ctx, 201, issueJson(repo, issue));
}

function issueList(ctx: Ctx, repo: RepoRec, params: URLSearchParams): void {
  const state = params.get('state') ?? 'open';
  const direction = params.get('direction') ?? 'desc';
  const perPage = Math.max(1, parseInt(params.get('per_page') ?? '30', 10) || 30);
  let list = repo.issues.filter((i) => state === 'all' || i.state === state);
  list = [...list].sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
  j(ctx, 200, list.slice(0, perPage).map((i) => issueJson(repo, i)));
}

function findIssue(repo: RepoRec, n: number): IssueRec | undefined {
  return repo.issues.find((i) => i.number === n);
}

// ---------------------------------------------------------------------------
// Pull requests: list/get, the files diff, and the squash merge (spec §3.5)
// ---------------------------------------------------------------------------

function linesOf(data: Buffer): string[] {
  const text = data.toString('utf8');
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Line-diff counts between two file versions (LCS over lines). */
function diffCounts(oldData: Buffer | null, newData: Buffer | null): { additions: number; deletions: number } {
  const a = oldData === null ? [] : linesOf(oldData);
  const b = newData === null ? [] : linesOf(newData);
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let x = a.length - 1; x >= 0; x--) {
    for (let y = b.length - 1; y >= 0; y--) {
      dp[x][y] = a[x] === b[y] ? dp[x + 1][y + 1] + 1 : Math.max(dp[x + 1][y], dp[x][y + 1]);
    }
  }
  const common = dp[0][0];
  return { additions: b.length - common, deletions: a.length - common };
}

function pullFiles(ctx: Ctx, repo: RepoRec, pr: PullRec): void {
  const forge = ctx.forge;
  const baseTip = forge.branchTip(repo, pr.baseRef);
  const headTip = forge.branchTip(repo, pr.headRef);
  const baseFiles = baseTip ? flattenTree(forge.store, parseCommit(forge.store.get(baseTip)?.data ?? Buffer.alloc(0)).tree) : new Map();
  const headFiles = headTip ? flattenTree(forge.store, parseCommit(forge.store.get(headTip)?.data ?? Buffer.alloc(0)).tree) : new Map();
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  const out: Array<Record<string, unknown>> = [];
  for (const path of [...paths].sort()) {
    const before = baseFiles.get(path);
    const after = headFiles.get(path);
    if (before?.oid === after?.oid) continue;
    const oldData = before ? (forge.store.get(before.oid)?.data ?? null) : null;
    const newData = after ? (forge.store.get(after.oid)?.data ?? null) : null;
    const { additions, deletions } = diffCounts(oldData, newData);
    out.push({
      filename: path,
      status: before === undefined ? 'added' : after === undefined ? 'deleted' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
      sha: after?.oid ?? before?.oid ?? ZERO_OID,
    });
  }
  j(ctx, 200, out);
}

function pullMerge(ctx: Ctx, repo: RepoRec, pr: PullRec): void {
  const commitOid = performSquashMerge(ctx.forge, repo, pr);
  if (commitOid === null) {
    fail(ctx, 405, 'Pull request has conflicts that must be resolved');
    return;
  }
  j(ctx, 200, { merged: true, sha: commitOid, message: 'Pull Request successfully merged' });
}

function findPull(repo: RepoRec, n: number): PullRec | undefined {
  return repo.pulls.find((p) => p.number === n);
}

// ---------------------------------------------------------------------------
// The router
// ---------------------------------------------------------------------------

export function handleRest(
  forge: Forge,
  method: string,
  path: string,
  params: URLSearchParams,
  body: Buffer,
  res: ServerResponse,
  sendJson: SendJson,
  baseUrl: string,
): void {
  const ctx: Ctx = { forge, res, sendJson, baseUrl };
  const seg = path.split('/').filter((s) => s !== ''); // ['api','v3',...]

  if (seg.length === 2) {
    // GET /api/v3/
    if (method === 'GET') {
      j(ctx, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
      return;
    }
    fail(ctx, 404, 'Not Found');
    return;
  }
  const rest = seg.slice(2).map((s) => decodeURIComponent(s));

  if (rest[0] === 'meta' && rest.length === 1 && method === 'GET') {
    j(ctx, 200, { installed_version: 'forge-1.0.0' });
    return;
  }
  if (rest[0] === 'user' && rest.length === 1 && method === 'GET') {
    j(ctx, 200, { login: forge.viewer ?? '' });
    return;
  }
  if (rest[0] === 'user' && rest[1] === 'repos' && rest.length === 2) {
    if (method === 'POST') {
      const input = jsonBody(ctx, body);
      if (!input) return;
      const name = typeof input.name === 'string' ? input.name : '';
      if (name === '') {
        fail(ctx, 422, 'name is required');
        return;
      }
      if (forge.repoByName(name)) {
        fail(ctx, 422, 'name already exists on this account');
        return;
      }
      const repo = forge.createRepo(
        name,
        typeof input.description === 'string' ? input.description : '',
        input.private === true,
      );
      j(ctx, 201, repoJson(forge, repo));
      return;
    }
    if (method === 'GET') {
      const perPage = Math.max(1, parseInt(params.get('per_page') ?? '30', 10) || 30);
      const page = Math.max(1, parseInt(params.get('page') ?? '1', 10) || 1);
      const all = forge.allRepos();
      const slice = all.slice((page - 1) * perPage, page * perPage);
      const headers: Record<string, string> = {};
      if (page * perPage < all.length) {
        headers.link = `<${baseUrl}/api/v3/user/repos?page=${page + 1}&per_page=${perPage}>; rel="next"`;
      }
      j(ctx, 200, slice.map((r) => repoJson(forge, r)), headers);
      return;
    }
    fail(ctx, 404, 'Not Found');
    return;
  }

  if (rest[0] === 'repos' && rest.length >= 3) {
    const owner = rest[1];
    const repoName = rest[2];
    const repo = forge.repoFor(owner, repoName);
    if (!repo) {
      fail(ctx, 404, 'Not Found');
      return;
    }
    const tail = rest.slice(3);

    if (tail.length === 0) {
      if (method === 'GET') {
        j(ctx, 200, repoJson(forge, repo));
        return;
      }
      if (method === 'PATCH') {
        const input = jsonBody(ctx, body);
        if (!input) return;
        if (typeof input.description === 'string') repo.description = input.description;
        if (typeof input.private === 'boolean') repo.isPrivate = input.private;
        j(ctx, 200, repoJson(forge, repo));
        return;
      }
      if (method === 'DELETE') {
        forge.deleteRepo(repoName);
        res.writeHead(204, { 'x-github-request-id': forge.requestId() });
        res.end();
        return;
      }
      fail(ctx, 404, 'Not Found');
      return;
    }

    if (tail[0] === 'git' && tail[1] === 'refs') {
      if (method === 'POST' && tail.length === 2) {
        const input = jsonBody(ctx, body);
        if (!input) return;
        const ref = typeof input.ref === 'string' ? input.ref : '';
        const sha = typeof input.sha === 'string' ? input.sha : '';
        if (!forge.store.has(sha)) {
          fail(ctx, 422, 'sha does not exist');
          return;
        }
        repo.refs.set(ref, sha);
        j(ctx, 201, { ref, object: { sha, type: 'commit' } });
        return;
      }
      if (method === 'GET' && tail.length >= 3) {
        const ref = `refs/${tail.slice(2).join('/')}`;
        const sha = repo.refs.get(ref);
        if (!sha) {
          fail(ctx, 404, 'Not Found');
          return;
        }
        j(ctx, 200, { ref, object: { sha, type: 'commit' } });
        return;
      }
      fail(ctx, 404, 'Not Found');
      return;
    }

    if (tail[0] === 'branches') {
      if (method === 'GET' && tail.length === 1) {
        const out = [...repo.refs.entries()]
          .filter(([ref]) => ref.startsWith('refs/heads/'))
          .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha } }));
        j(ctx, 200, out);
        return;
      }
      if (method === 'GET' && tail.length === 2) {
        const sha = forge.branchTip(repo, tail[1]);
        if (!sha) {
          fail(ctx, 404, 'Not Found');
          return;
        }
        j(ctx, 200, { name: tail[1], commit: { sha } });
        return;
      }
      fail(ctx, 404, 'Not Found');
      return;
    }

    if (tail[0] === 'commits' && tail.length === 1 && method === 'GET') {
      const shaParam = params.get('sha');
      let tip: string | null = null;
      if (shaParam) {
        tip = forge.branchTip(repo, shaParam) ?? repo.refs.get(shaParam) ?? (forge.store.has(shaParam) ? shaParam : null);
      } else {
        tip = forge.branchTip(repo, repo.defaultBranch);
      }
      if (!tip) {
        j(ctx, 200, []);
        return;
      }
      const list = listCommits(forge, tip).map((oid) => {
        const commit = parseCommit(forge.store.get(oid)?.data ?? Buffer.alloc(0));
        return { sha: oid, commit: { message: commit.message, tree: { sha: commit.tree } }, parents: commit.parents.map((p) => ({ sha: p })) };
      });
      j(ctx, 200, list);
      return;
    }

    if (tail[0] === 'contents') {
      const contentPath = tail.slice(1).join('/');
      if (method === 'PUT') {
        contentsPut(ctx, repo, contentPath, body);
        return;
      }
      if (method === 'GET') {
        contentsGet(ctx, repo, contentPath, params);
        return;
      }
      if (method === 'DELETE') {
        contentsDelete(ctx, repo, contentPath, body);
        return;
      }
      fail(ctx, 404, 'Not Found');
      return;
    }

    if (tail[0] === 'labels' && tail.length === 1 && method === 'POST') {
      const input = jsonBody(ctx, body);
      if (!input) return;
      const name = typeof input.name === 'string' ? input.name : '';
      const color = typeof input.color === 'string' ? input.color : 'ededed';
      repo.labels.set(name, { name, color });
      j(ctx, 201, { name, color });
      return;
    }

    if (tail[0] === 'issues') {
      if (tail.length === 1) {
        if (method === 'POST') {
          issueCreate(ctx, repo, body);
          return;
        }
        if (method === 'GET') {
          issueList(ctx, repo, params);
          return;
        }
      }
      if (tail.length >= 2) {
        const n = parseInt(tail[1], 10);
        const issue = findIssue(repo, n);
        if (!issue) {
          fail(ctx, 404, 'Not Found');
          return;
        }
        if (tail.length === 2) {
          if (method === 'GET') {
            j(ctx, 200, issueJson(repo, issue));
            return;
          }
          if (method === 'PATCH') {
            const input = jsonBody(ctx, body);
            if (!input) return;
            if (input.state === 'closed' || input.state === 'open') issue.state = input.state;
            if (typeof input.title === 'string') issue.title = input.title;
            if (typeof input.body === 'string') issue.body = input.body;
            if (Array.isArray(input.labels)) {
              const labels = input.labels.map((l) => String(l));
              for (const name of labels) {
                if (!repo.labels.has(name)) {
                  fail(ctx, 422, `Label "${name}" does not exist on this repository`);
                  return;
                }
              }
              issue.labels = labels;
            }
            j(ctx, 200, issueJson(repo, issue));
            return;
          }
        }
        if (tail.length === 3 && tail[2] === 'comments') {
          if (method === 'POST') {
            const input = jsonBody(ctx, body);
            if (!input) return;
            const comment = { id: repo.nextCommentId++, body: typeof input.body === 'string' ? input.body : '' };
            issue.comments.push(comment);
            j(ctx, 201, comment);
            return;
          }
          if (method === 'GET') {
            j(ctx, 200, issue.comments);
            return;
          }
        }
      }
      fail(ctx, 404, 'Not Found');
      return;
    }

    if (tail[0] === 'pulls') {
      if (tail.length === 1) {
        if (method === 'POST') {
          const input = jsonBody(ctx, body);
          if (!input) return;
          const stripOwner = (ref: string) => (ref.includes(':') ? ref.split(':').pop() as string : ref);
          const pr: PullRec = {
            id: forge.allocNodeId(),
            number: repo.nextNumber++,
            title: typeof input.title === 'string' ? input.title : '',
            body: typeof input.body === 'string' ? input.body : '',
            state: 'open',
            merged: false,
            mergedAt: null,
            mergeCommitSha: null,
            headRef: stripOwner(typeof input.head === 'string' ? input.head : ''),
            baseRef: stripOwner(typeof input.base === 'string' ? input.base : repo.defaultBranch),
          };
          repo.pulls.push(pr);
          j(ctx, 201, pullJson(forge, repo, pr));
          return;
        }
        if (method === 'GET') {
          const state = params.get('state') ?? 'open';
          const list = repo.pulls.filter((p) => state === 'all' || p.state === state);
          j(ctx, 200, list.map((p) => pullJson(forge, repo, p)));
          return;
        }
      }
      if (tail.length >= 2) {
        const n = parseInt(tail[1], 10);
        const pr = findPull(repo, n);
        if (!pr) {
          fail(ctx, 404, 'Not Found');
          return;
        }
        if (tail.length === 2 && method === 'GET') {
          j(ctx, 200, pullJson(forge, repo, pr));
          return;
        }
        if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
          pullFiles(ctx, repo, pr);
          return;
        }
        if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
          pullMerge(ctx, repo, pr);
          return;
        }
      }
      fail(ctx, 404, 'Not Found');
      return;
    }

    fail(ctx, 404, 'Not Found');
    return;
  }

  fail(ctx, 404, 'Not Found');
}
