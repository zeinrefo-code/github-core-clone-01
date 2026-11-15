// GraphQL v4 (POST /api/graphql): a small purpose-built executor for the
// documents gh and github-mcp-server send — viewer, repository fields,
// introspection of the Issue / PullRequest / Repository / SearchType types,
// issue and pull-request connections with cursor pagination, node() lookups
// by global id, and the five mutations. Everything resolves against the
// shared store, so GraphQL writes are REST reads and vice versa.
//
// Global ids are opaque and stable: base64 of "<Type>:<repoDbId>[:<number>]",
// never the bare databaseId, and they round-trip through node() and the
// mutation inputs.

import type { ServerResponse } from 'node:http';
import { flattenTree, parseCommit } from './gitstore.ts';
import { performSquashMerge, type Forge, type IssueRec, type PullRec, type RepoRec } from './forge.ts';

type SendJson = (res: ServerResponse, status: number, body: unknown, headers?: Readonly<Record<string, string>>) => void;

// ---------------------------------------------------------------------------
// Global ids
// ---------------------------------------------------------------------------

function globalId(kind: string, repoId: number, number?: number): string {
  const raw = number === undefined ? `${kind}:${repoId}` : `${kind}:${repoId}:${number}`;
  return Buffer.from(raw, 'utf8').toString('base64');
}

function decodeGlobalId(id: string): { kind: string; repoId: number; number?: number; commentId?: number } | null {
  try {
    const raw = Buffer.from(id, 'base64').toString('utf8');
    const fields = raw.split(':');
    if (fields.length < 2) return null;
    const repoId = parseInt(fields[1], 10);
    if (Number.isNaN(repoId)) return null;
    if (fields[0] === 'IssueComment') {
      return { kind: fields[0], repoId, number: parseInt(fields[2], 10), commentId: parseInt(fields[3], 10) };
    }
    return { kind: fields[0], repoId, number: fields.length > 2 ? parseInt(fields[2], 10) : undefined };
  } catch {
    return null;
  }
}

function commentGlobalId(repoId: number, issueNumber: number, commentId: number): string {
  return Buffer.from(`IssueComment:${repoId}:${issueNumber}:${commentId}`, 'utf8').toString('base64');
}

// ---------------------------------------------------------------------------
// A small GraphQL parser: operations, aliases, arguments (literals and
// $variables), nested input objects and lists, inline fragments.
// ---------------------------------------------------------------------------

type Value =
  | { kind: 'var'; name: string }
  | { kind: 'str'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Array<[string, Value]> };

interface FieldNode {
  name: string;
  alias: string | null;
  args: Array<[string, Value]>;
  selections: SelectionNode[];
}

type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'fragment'; typeName: string; selections: SelectionNode[] };

interface Operation {
  type: 'query' | 'mutation';
  selections: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly text: string;
  constructor(text: string) {
    this.text = text;
  }

  private skip(): void {
    for (;;) {
      const ch = this.text[this.pos];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') this.pos++;
      else if (ch === '#') while (this.pos < this.text.length && this.text[this.pos] !== '\n') this.pos++;
      else break;
    }
  }

  private peek(): string {
    this.skip();
    return this.text[this.pos] ?? '';
  }

  private expect(ch: string): void {
    this.skip();
    if (this.text[this.pos] !== ch) throw new Error(`expected ${ch} at ${this.pos}`);
    this.pos++;
  }

  private name(): string {
    this.skip();
    const match = /^[_A-Za-z][_0-9A-Za-z]*/.exec(this.text.slice(this.pos));
    if (!match) throw new Error(`expected a name at ${this.pos}`);
    this.pos += match[0].length;
    return match[0];
  }

  private string(): string {
    this.skip();
    if (this.text[this.pos] !== '"') throw new Error('expected a string');
    this.pos++;
    let out = '';
    while (this.pos < this.text.length && this.text[this.pos] !== '"') {
      if (this.text[this.pos] === '\\') {
        const esc = this.text[this.pos + 1];
        out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
        this.pos += 2;
      } else {
        out += this.text[this.pos];
        this.pos++;
      }
    }
    this.pos++;
    return out;
  }

  private value(): Value {
    const ch = this.peek();
    if (ch === '$') {
      this.pos++;
      return { kind: 'var', name: this.name() };
    }
    if (ch === '"') return { kind: 'str', value: this.string() };
    if (ch === '[') {
      this.pos++;
      const items: Value[] = [];
      while (this.peek() !== ']') items.push(this.value());
      this.pos++;
      return { kind: 'list', items };
    }
    if (ch === '{') {
      this.pos++;
      const fields: Array<[string, Value]> = [];
      while (this.peek() !== '}') {
        const key = this.name();
        this.expect(':');
        fields.push([key, this.value()]);
      }
      this.pos++;
      return { kind: 'object', fields };
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      const match = /^-?\d+/.exec(this.text.slice(this.pos));
      if (!match) throw new Error('bad number');
      this.pos += match[0].length;
      return { kind: 'int', value: parseInt(match[0], 10) };
    }
    const word = this.name();
    if (word === 'true') return { kind: 'bool', value: true };
    if (word === 'false') return { kind: 'bool', value: false };
    if (word === 'null') return { kind: 'null' };
    return { kind: 'enum', value: word };
  }

  private selections(): SelectionNode[] {
    this.expect('{');
    const out: SelectionNode[] = [];
    while (this.peek() !== '}') {
      if (this.text.startsWith('...', this.pos)) {
        this.pos += 3;
        const on = this.name();
        if (on !== 'on') throw new Error('only inline fragments are supported');
        const typeName = this.name();
        out.push({ kind: 'fragment', typeName, selections: this.selections() });
      } else {
        out.push({ kind: 'field', field: this.field() });
      }
    }
    this.pos++;
    return out;
  }

  private field(): FieldNode {
    let name = this.name();
    let alias: string | null = null;
    if (this.peek() === ':') {
      this.pos++;
      alias = name;
      name = this.name();
    }
    const args: Array<[string, Value]> = [];
    if (this.peek() === '(') {
      this.pos++;
      while (this.peek() !== ')') {
        const key = this.name();
        this.expect(':');
        args.push([key, this.value()]);
      }
      this.pos++;
    }
    const selections = this.peek() === '{' ? this.selections() : [];
    return { name, alias, args, selections };
  }

  parseDocument(): Operation {
    // Skip fragment definitions if any appear; the suite sends none.
    for (;;) {
      const word = this.name();
      if (word === 'query' || word === 'mutation') {
        // Optional operation name, then optional variable definitions.
        if (/[_A-Za-z]/.test(this.peek())) this.name();
        if (this.peek() === '(') {
          let depth = 0;
          do {
            const ch = this.text[this.pos++];
            if (ch === '(') depth++;
            else if (ch === ')') depth--;
          } while (depth > 0 && this.pos < this.text.length);
        }
        return { type: word, selections: this.selections() };
      }
      if (word === 'fragment') {
        this.name();
        this.name(); // 'on'
        this.name(); // type name
        this.selections();
        continue;
      }
      throw new Error(`unsupported definition ${word}`);
    }
  }
}

function resolveValue(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'var':
      return variables[value.name];
    case 'str':
      return value.value;
    case 'int':
      return value.value;
    case 'bool':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, item] of value.fields) out[key] = resolveValue(item, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of field.args) out[key] = resolveValue(value, variables);
  return out;
}

// ---------------------------------------------------------------------------
// The executor. Values are plain objects tagged with __typename; field
// resolution is a switch per type. Unknown fields produce GitHub-worded
// errors naming the field, as the invalid-field check requires.
// ---------------------------------------------------------------------------

type Obj = Record<string, unknown> & { __typename: string };

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id', 'name'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef',
    'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest',
    'pullRequests', 'description', 'isPrivate', 'createdAt', 'updatedAt', 'url',
  ],
  Issue: [
    'id', 'number', 'title', 'state', 'body', 'labels', 'comments', 'author',
    'repository', 'createdAt', 'updatedAt', 'closed', 'url',
  ],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable',
    'headRefName', 'baseRefName', 'files', 'author', 'repository', 'createdAt',
    'updatedAt', 'closed', 'mergedAt', 'url',
  ],
  Ref: ['name', 'target'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestFileConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestFile: ['path', 'additions', 'deletions', 'changeType'],
  PageInfo: ['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'],
  CommentEdge: ['node'],
  IssueComment: ['id', 'body', 'author', 'createdAt'],
  __Type: ['name', 'fields', 'enumValues', 'kind'],
  __Field: ['name'],
  __EnumValue: ['name'],
};

interface GqlContext {
  forge: Forge;
  errors: Array<{ message: string }>;
}

function userObj(forge: Forge): Obj {
  return { __typename: 'User', login: forge.viewer ?? '' };
}

function repoObj(repo: RepoRec): Obj {
  return { __typename: 'Repository', repo };
}

function issueObj(repo: RepoRec, issue: IssueRec): Obj {
  return { __typename: 'Issue', repo, issue };
}

function pullObj(repo: RepoRec, pr: PullRec): Obj {
  return { __typename: 'PullRequest', repo, pr };
}

function cursorFor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function indexFromCursor(cursor: string): number {
  try {
    const raw = Buffer.from(cursor, 'base64').toString('utf8');
    const n = parseInt(raw.replace('cursor:', ''), 10);
    return Number.isNaN(n) ? -1 : n;
  } catch {
    return -1;
  }
}

interface ConnectionSpec<T> {
  items: T[];
  first: number | undefined;
  after: string | undefined;
}

/** Slice a connection page and build its {nodes, pageInfo} object. */
function paginate<T>(spec: ConnectionSpec<T>, wrap: (item: T) => Obj, typename: string): Obj {
  const first = spec.first === undefined ? spec.items.length : Math.max(0, spec.first);
  const start = spec.after === undefined || spec.after === null ? 0 : indexFromCursor(spec.after) + 1;
  const page = spec.items.slice(start, start + first);
  const lastIndex = start + page.length - 1;
  return {
    __typename: typename,
    nodes: page.map(wrap),
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: start + page.length < spec.items.length,
      endCursor: page.length > 0 ? cursorFor(lastIndex) : null,
      hasPreviousPage: start > 0,
      startCursor: page.length > 0 ? cursorFor(start) : null,
    },
    totalCount: spec.items.length,
  };
}

/** The paths a pull request changes (head tree vs base tree), for files(). */
function pullFilePaths(forge: Forge, repo: RepoRec, pr: PullRec): string[] {
  const filesAt = (branch: string) => {
    const tip = forge.branchTip(repo, branch);
    if (!tip) return new Map<string, { mode: string; oid: string }>();
    const commit = forge.store.get(tip);
    if (!commit || commit.type !== 'commit') return new Map();
    return flattenTree(forge.store, parseCommit(commit.data).tree);
  };
  const base = filesAt(pr.baseRef);
  const head = filesAt(pr.headRef);
  const paths = new Set([...base.keys(), ...head.keys()]);
  return [...paths].filter((p) => base.get(p)?.oid !== head.get(p)?.oid).sort();
}

function resolveRepositoryField(ctx: GqlContext, repo: RepoRec, field: FieldNode, args: Record<string, unknown>): unknown {
  const forge = ctx.forge;
  switch (field.name) {
    case 'id':
      return globalId('Repository', repo.id);
    case 'databaseId':
      return repo.id;
    case 'name':
      return repo.name;
    case 'nameWithOwner':
      return `${forge.viewer ?? ''}/${repo.name}`;
    case 'owner':
      return userObj(forge);
    case 'defaultBranchRef':
      return { __typename: 'Ref', name: repo.defaultBranch };
    case 'viewerPermission':
      return 'ADMIN';
    case 'hasIssuesEnabled':
      return true;
    case 'description':
      return repo.description;
    case 'isPrivate':
      return repo.isPrivate;
    case 'issue': {
      const found = repo.issues.find((i) => i.number === args.number);
      return found ? issueObj(repo, found) : null;
    }
    case 'issues': {
      let list = [...repo.issues];
      const states = args.states as string[] | undefined;
      if (Array.isArray(states) && states.length > 0) {
        const wanted = new Set(states.map((s) => (s === 'OPEN' ? 'open' : 'closed')));
        list = list.filter((i) => wanted.has(i.state));
      }
      const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
      if (orderBy?.direction === 'DESC') list.sort((a, b) => b.number - a.number);
      else list.sort((a, b) => a.number - b.number);
      return paginate(
        { items: list, first: args.first as number | undefined, after: args.after as string | undefined },
        (i) => issueObj(repo, i),
        'IssueConnection',
      );
    }
    case 'pullRequest': {
      const found = repo.pulls.find((p) => p.number === args.number);
      return found ? pullObj(repo, found) : null;
    }
    case 'pullRequests': {
      const list = [...repo.pulls].sort((a, b) => a.number - b.number);
      return paginate(
        { items: list, first: args.first as number | undefined, after: args.after as string | undefined },
        (p) => pullObj(repo, p),
        'PullRequestConnection',
      );
    }
    default:
      return null;
  }
}

function resolvePullField(ctx: GqlContext, repo: RepoRec, pr: PullRec, field: FieldNode, args: Record<string, unknown>): unknown {
  switch (field.name) {
    case 'id':
      return globalId('PullRequest', repo.id, pr.number);
    case 'number':
      return pr.number;
    case 'title':
      return pr.title;
    case 'body':
      return pr.body;
    case 'state':
      return pr.state === 'open' ? 'OPEN' : 'CLOSED';
    case 'merged':
      return pr.merged;
    case 'mergeable':
      return 'MERGEABLE';
    case 'headRefName':
      return pr.headRef;
    case 'baseRefName':
      return pr.baseRef;
    case 'files': {
      const paths = pullFilePaths(ctx.forge, repo, pr).map((path) => ({
        __typename: 'PullRequestFile',
        path,
        additions: 0,
        deletions: 0,
        changeType: 'MODIFIED',
      }) as Obj);
      return paginate(
        { items: paths, first: args.first as number | undefined, after: args.after as string | undefined },
        (f) => f,
        'PullRequestFileConnection',
      );
    }
    default:
      return null;
  }
}

function resolveField(ctx: GqlContext, obj: Obj, field: FieldNode, variables: Record<string, unknown>): unknown {
  const args = argsOf(field, variables);
  const forge = ctx.forge;
  switch (obj.__typename) {
    case 'Query':
      switch (field.name) {
        case 'viewer':
          return userObj(forge);
        case 'repository': {
          const repo = forge.repoFor(String(args.owner ?? ''), String(args.name ?? ''));
          return repo ? repoObj(repo) : null;
        }
        case 'node': {
          const decoded = decodeGlobalId(String(args.id ?? ''));
          if (!decoded) return null;
          const repo = forge.repoById(decoded.repoId);
          if (!repo) return null;
          if (decoded.kind === 'Repository') return repoObj(repo);
          if (decoded.kind === 'Issue') {
            const issue = repo.issues.find((i) => i.number === decoded.number);
            return issue ? issueObj(repo, issue) : null;
          }
          if (decoded.kind === 'PullRequest') {
            const pr = repo.pulls.find((p) => p.number === decoded.number);
            return pr ? pullObj(repo, pr) : null;
          }
          return null;
        }
        case '__type': {
          const name = String(args.name ?? '');
          const fields = (TYPE_FIELDS[name] ?? []).map((n) => ({ __typename: '__Field', name: n }) as Obj);
          const enumValues =
            name === 'SearchType'
              ? ['ISSUE', 'REPOSITORY', 'USER'].map((n) => ({ __typename: '__EnumValue', name: n }) as Obj)
              : [];
          return { __typename: '__Type', name, fields, enumValues, kind: name === 'SearchType' ? 'ENUM' : 'OBJECT' } as Obj;
        }
        case '__schema':
          return null;
        default:
          return null;
      }
    case 'Mutation':
      return resolveMutation(ctx, field.name, (args.input ?? {}) as Record<string, unknown>);
    case 'User':
      if (field.name === 'login') return obj.login;
      if (field.name === 'id') return globalId('User', 1);
      return null;
    case 'Repository':
      return resolveRepositoryField(ctx, obj.repo as RepoRec, field, args);
    case 'Issue': {
      const repo = obj.repo as RepoRec;
      const issue = obj.issue as IssueRec;
      switch (field.name) {
        case 'id':
          return globalId('Issue', repo.id, issue.number);
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'body':
          return issue.body;
        case 'state':
          return issue.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'closed':
          return issue.state === 'closed';
        default:
          return null;
      }
    }
    case 'PullRequest':
      return resolvePullField(ctx, obj.repo as RepoRec, obj.pr as PullRec, field, args);
    default:
      // Connections, payloads, pageInfo, files, __Type parts: stored fields.
      return (obj as Record<string, unknown>)[field.name] ?? null;
  }
}

function resolveMutation(ctx: GqlContext, name: string, input: Record<string, unknown>): Obj | null {
  const forge = ctx.forge;
  switch (name) {
    case 'createIssue': {
      const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
      const repo = decoded ? forge.repoById(decoded.repoId) : null;
      if (!repo) return null;
      const issue: IssueRec = {
        id: forge.allocNodeId(),
        number: repo.nextNumber++,
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        labels: [],
        comments: [],
      };
      repo.issues.push(issue);
      return { __typename: 'CreateIssuePayload', issue: issueObj(repo, issue) };
    }
    case 'closeIssue': {
      const decoded = decodeGlobalId(String(input.issueId ?? ''));
      const repo = decoded ? forge.repoById(decoded.repoId) : null;
      const issue = repo?.issues.find((i) => i.number === decoded?.number);
      if (!repo || !issue) return null;
      issue.state = 'closed';
      return { __typename: 'CloseIssuePayload', issue: issueObj(repo, issue) };
    }
    case 'createPullRequest': {
      const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
      const repo = decoded ? forge.repoById(decoded.repoId) : null;
      if (!repo) return null;
      const pr: PullRec = {
        id: forge.allocNodeId(),
        number: repo.nextNumber++,
        title: typeof input.title === 'string' ? input.title : '',
        body: '',
        state: 'open',
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        headRef: typeof input.headRefName === 'string' ? input.headRefName : '',
        baseRef: typeof input.baseRefName === 'string' ? input.baseRefName : repo.defaultBranch,
      };
      repo.pulls.push(pr);
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullObj(repo, pr) };
    }
    case 'mergePullRequest': {
      const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
      const repo = decoded ? forge.repoById(decoded.repoId) : null;
      const pr = repo?.pulls.find((p) => p.number === decoded?.number);
      if (!repo || !pr) return null;
      performSquashMerge(forge, repo, pr);
      return { __typename: 'MergePullRequestPayload', pullRequest: pullObj(repo, pr) };
    }
    case 'addComment': {
      const decoded = decodeGlobalId(String(input.subjectId ?? ''));
      const repo = decoded ? forge.repoById(decoded.repoId) : null;
      const issue = repo?.issues.find((i) => i.number === decoded?.number);
      if (!repo || !issue) return null;
      const comment = { id: repo.nextCommentId++, body: typeof input.body === 'string' ? input.body : '' };
      issue.comments.push(comment);
      const node: Obj = {
        __typename: 'IssueComment',
        id: commentGlobalId(repo.id, issue.number, comment.id),
        body: comment.body,
      };
      return { __typename: 'AddCommentPayload', commentEdge: { __typename: 'CommentEdge', node } };
    }
    default:
      return null;
  }
}

/** Execute a selection set against a tagged object, honouring aliases and inline fragments. */
function executeSelections(
  ctx: GqlContext,
  obj: Obj,
  selections: SelectionNode[],
  variables: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeName === obj.__typename) {
        Object.assign(out, executeSelections(ctx, obj, selection.selections, variables));
      }
      continue;
    }
    const field = selection.field;
    const key = field.alias ?? field.name;
    const known = TYPE_FIELDS[obj.__typename];
    if (known && !known.includes(field.name) && !field.name.startsWith('__')) {
      ctx.errors.push({ message: `Field "${field.name}" cannot be queried on type "${obj.__typename}"` });
      out[key] = null;
      continue;
    }
    const raw = resolveField(ctx, obj, field, variables);
    out[key] = completeValue(ctx, raw, field.selections, variables);
  }
  return out;
}

function completeValue(
  ctx: GqlContext,
  raw: unknown,
  selections: SelectionNode[],
  variables: Record<string, unknown>,
): unknown {
  if (raw === null || raw === undefined) return null;
  if (Array.isArray(raw)) return raw.map((item) => completeValue(ctx, item, selections, variables));
  if (typeof raw === 'object' && selections.length > 0) {
    return executeSelections(ctx, raw as Obj, selections, variables);
  }
  return raw;
}

function executeOne(forge: Forge, payload: { query?: string; variables?: Record<string, unknown> }): Record<string, unknown> {
  const ctx: GqlContext = { forge, errors: [] };
  try {
    const operation = new Parser(String(payload.query ?? '')).parseDocument();
    const root: Obj = { __typename: operation.type === 'mutation' ? 'Mutation' : 'Query' };
    const data = executeSelections(ctx, root, operation.selections, payload.variables ?? {});
    const envelope: Record<string, unknown> = { data };
    if (ctx.errors.length > 0) envelope.errors = ctx.errors;
    return envelope;
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'GraphQL error' }] };
  }
}

export async function handleGraphQL(forge: Forge, body: Buffer, res: ServerResponse, sendJson: SendJson): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Malformed JSON in request body' }] });
    return;
  }
  if (Array.isArray(parsed)) {
    sendJson(res, 200, parsed.map((item) => executeOne(forge, item as { query?: string })));
    return;
  }
  sendJson(res, 200, executeOne(forge, parsed as { query?: string }));
}
