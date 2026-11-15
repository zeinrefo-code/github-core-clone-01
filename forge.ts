// The forge's shared state: one object store, one learned viewer, and the
// repositories with their refs, issues, pull requests and labels. Every
// surface (git, REST, GraphQL, MCP) reads and writes this one store, so an
// object created over any surface is visible over all the others with the
// same ids.
//
// Determinism: ids and timestamps come from logical counters, never from the
// wall clock or randomness, so a replayed trial produces identical answers.

import {
  ObjectStore,
  buildCommitData,
  flattenTree,
  mergeBase,
  parseCommit,
} from './gitstore.ts';

export interface CommentRec {
  id: number;
  body: string;
}

export interface IssueRec {
  /** Global database id (GitHub issues carry one beside the number). */
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
}

export interface PullRec {
  /** Global database id, from the same sequence as issue ids. */
  id: number;
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
  private nextNodeId = 1;
  private clock = 0;
  private requestSeq = 0;

  /** The next global database id for an issue or pull request. */
  allocNodeId(): number {
    return this.nextNodeId++;
  }

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

  repoById(id: number): RepoRec | null {
    for (const repo of this.repos.values()) if (repo.id === id) return repo;
    return null;
  }
}

/**
 * Squash-merge a pull request: one new commit on the base branch whose tree
 * is the head tip's tree. Returns the merge commit oid, or null when the
 * merge conflicts — the base has moved since the merge-base and some path
 * changed on both sides to different results. On success the PR record is
 * updated (closed, merged, merge_commit_sha).
 */
export function performSquashMerge(forge: Forge, repo: RepoRec, pr: PullRec): string | null {
  const baseTip = forge.branchTip(repo, pr.baseRef);
  const headTip = forge.branchTip(repo, pr.headRef);
  if (!baseTip || !headTip) return null;
  const mb = mergeBase(forge.store, headTip, baseTip);
  if (mb !== null && mb !== baseTip) {
    const filesAt = (commitOid: string) =>
      flattenTree(forge.store, parseCommit(forge.store.get(commitOid)?.data ?? Buffer.alloc(0)).tree);
    const mbFiles = filesAt(mb);
    const baseFiles = filesAt(baseTip);
    const headFiles = filesAt(headTip);
    const paths = new Set([...mbFiles.keys(), ...baseFiles.keys(), ...headFiles.keys()]);
    for (const path of paths) {
      const inMb = mbFiles.get(path)?.oid;
      const inBase = baseFiles.get(path)?.oid;
      const inHead = headFiles.get(path)?.oid;
      if (inBase !== inMb && inHead !== inMb && inBase !== inHead) return null;
    }
  }
  const headTree = parseCommit(forge.store.get(headTip)?.data ?? Buffer.alloc(0)).tree;
  const data = buildCommitData({
    tree: headTree,
    parents: [baseTip],
    message: `${pr.title} (#${pr.number})`,
    authorLine: forge.authorLine(),
  });
  const commitOid = forge.store.store('commit', data);
  forge.setBranch(repo, pr.baseRef, commitOid);
  pr.state = 'closed';
  pr.merged = true;
  pr.mergedAt = forge.isoNow();
  pr.mergeCommitSha = commitOid;
  return commitOid;
}
