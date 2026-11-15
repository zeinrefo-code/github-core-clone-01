// The forge's shared state: one object store, one learned viewer, and the
// repositories with their refs, issues, pull requests and labels. Every
// surface (git, REST, GraphQL, MCP) reads and writes this one store, so an
// object created over any surface is visible over all the others with the
// same ids.
//
// Determinism: ids and timestamps come from logical counters, never from the
// wall clock or randomness, so a replayed trial produces identical answers.

import { ObjectStore } from './gitstore.ts';

export interface CommentRec {
  id: number;
  body: string;
}

export interface IssueRec {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
}

export interface PullRec {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
}

export interface RepoRec {
  id: number;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  /** One sequence shared by issues and pull requests (GitHub semantics). */
  nextNumber: number;
  nextCommentId: number;
  issues: IssueRec[];
  pulls: PullRec[];
  labels: Map<string, { name: string; color: string }>;
}

const EPOCH_BASE = 1767225600; // 2026-01-01T00:00:00Z; logical timestamps grow from here

export class Forge {
  readonly store = new ObjectStore();
  viewer: string | null = null;
  private readonly repos = new Map<string, RepoRec>();
  private nextRepoId = 1;
  private clock = 0;
  private requestSeq = 0;

  /** The next logical timestamp, as epoch seconds. */
  tick(): number {
    this.clock += 1;
    return EPOCH_BASE + this.clock;
  }

  isoNow(): string {
    return new Date(this.tick() * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  /** A git author/committer line with a logical timestamp. */
  authorLine(): string {
    return `Forge <forge@localhost> ${this.tick()} +0000`;
  }

  /** A deterministic, unique-per-request id for X-GitHub-Request-Id. */
  requestId(): string {
    this.requestSeq += 1;
    return `forge-${this.requestSeq.toString(16).padStart(8, '0')}`;
  }

  /**
   * Address a repository by owner + name. The first owner ever addressed is
   * learned as the token's login; any other owner is a 404, as is a missing
   * repository. Returns null for both failure cases.
   */
  repoFor(owner: string, name: string): RepoRec | null {
    if (this.viewer === null) this.viewer = owner;
    if (owner !== this.viewer) return null;
    return this.repos.get(name) ?? null;
  }

  /** Create a repository owned by the viewer (learning it from `owner` when given). */
  createRepo(name: string, description: string, isPrivate: boolean, owner?: string): RepoRec {
    if (owner !== undefined && this.viewer === null) this.viewer = owner;
    const repo: RepoRec = {
      id: this.nextRepoId++,
      name,
      description,
      isPrivate,
      defaultBranch: 'main',
      refs: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
      issues: [],
      pulls: [],
      labels: new Map(),
    };
    this.repos.set(name, repo);
    return repo;
  }

  repoByName(name: string): RepoRec | null {
    return this.repos.get(name) ?? null;
  }

  allRepos(): RepoRec[] {
    return [...this.repos.values()];
  }

  deleteRepo(name: string): boolean {
    return this.repos.delete(name);
  }

  /** The branch tip oid, or null when the branch does not exist yet. */
  branchTip(repo: RepoRec, branch: string): string | null {
    return repo.refs.get(`refs/heads/${branch}`) ?? null;
  }

  setBranch(repo: RepoRec, branch: string, oid: string): void {
    repo.refs.set(`refs/heads/${branch}`, oid);
  }
}
