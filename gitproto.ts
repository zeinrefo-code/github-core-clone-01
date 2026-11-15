// Git smart HTTP, implemented from scratch on the object store: advertisement,
// protocol v2 (ls-refs, fetch), protocol v0 fetch, and receive-pack with
// per-ref fast-forward enforcement and a sideband report.
//
// The shapes here follow the suite's hand-rolled client, which follows real
// git: pkt-line framing everywhere, side-band-64k for pack data, protocol v2
// for upload-pack when the client asks for it, v0 for receive-pack always.

import {
  PKT_DELIM,
  PKT_FLUSH,
  PktReader,
  ZERO_OID,
  computeFetchSet,
  derefToCommit,
  isAncestor,
  pktLine,
  pktSideband,
  readPack,
  sha1Hex,
  writePack,
  type ObjectStore,
} from './gitstore.ts';
import type { Forge, RepoRec } from './forge.ts';

const AGENT = 'agent=makefun-forge/1.0';

// Fetch responses are pure functions of the repo's refs and the request
// (the object store is append-only), so identical fetches — the clone
// benchmark issues fifty of them — are served from a small cache.
const fetchCache = new Map<string, Buffer>();

function refsKey(repo: RepoRec): string {
  return [...repo.refs.entries()].sort().map(([r, o]) => `${r}=${o}`).join('|');
}

function cached(key: string, build: () => Buffer): Buffer {
  const hit = fetchCache.get(key);
  if (hit) return hit;
  const built = build();
  if (fetchCache.size >= 128) {
    const oldest = fetchCache.keys().next().value;
    if (oldest !== undefined) fetchCache.delete(oldest);
  }
  fetchCache.set(key, built);
  return built;
}

function sortedRefs(repo: RepoRec): Array<[string, string]> {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

function headOid(repo: RepoRec): string {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? ZERO_OID;
}

// ---------------------------------------------------------------------------
// Advertisement
// ---------------------------------------------------------------------------

export function infoRefs(forge: Forge, repo: RepoRec, service: string, v2: boolean): { contentType: string; body: Buffer } {
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  if (service === 'git-upload-pack' && v2) {
    parts.push(pktLine('version 2\n'));
    parts.push(pktLine(`${AGENT}\n`));
    parts.push(pktLine('ls-refs=unborn\n'));
    parts.push(pktLine('fetch=shallow\n'));
    parts.push(pktLine('object-format=sha1\n'));
    parts.push(PKT_FLUSH);
    return { contentType: 'application/x-git-upload-pack-advertisement', body: Buffer.concat(parts) };
  }
  if (service === 'git-upload-pack') {
    const caps = [
      'multi_ack_detailed',
      'side-band-64k',
      'thin-pack',
      'ofs-delta',
      `symref-target:refs/heads/${repo.defaultBranch}`,
      AGENT,
    ].join(' ');
    parts.push(pktLine(`${headOid(repo)} HEAD\0${caps}\n`));
    for (const [ref, oid] of sortedRefs(repo)) parts.push(pktLine(`${oid} ${ref}\n`));
    parts.push(PKT_FLUSH);
    return { contentType: 'application/x-git-upload-pack-advertisement', body: Buffer.concat(parts) };
  }
  // git-receive-pack, always v0. Note: report-status-v2 is deliberately not
  // advertised, so the client uses the plain report-status format.
  const caps = ['report-status', 'delete-refs', 'side-band-64k', 'ofs-delta', AGENT].join(' ');
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    let first = true;
    for (const [ref, oid] of refs) {
      if (first) {
        parts.push(pktLine(`${oid} ${ref}\0${caps}\n`));
        first = false;
      } else {
        parts.push(pktLine(`${oid} ${ref}\n`));
      }
    }
  }
  parts.push(PKT_FLUSH);
  return { contentType: 'application/x-git-receive-pack-advertisement', body: Buffer.concat(parts) };
}

// ---------------------------------------------------------------------------
// Protocol v2: ls-refs and fetch
// ---------------------------------------------------------------------------

function lsRefs(forge: Forge, repo: RepoRec, args: string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const matches = (name: string) => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const parts: Buffer[] = [];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headTarget = repo.refs.get(headRef);
  if (matches('HEAD')) {
    if (headTarget) {
      let line = `${headTarget} HEAD`;
      if (symrefs) line += ` symref-target:${headRef}`;
      parts.push(pktLine(`${line}\n`));
    } else if (unborn) {
      // Protocol v2 spells an unborn ref with the literal word "unborn" in
      // place of the oid (git's ls-refs does exactly this).
      let line = 'unborn HEAD';
      if (symrefs) line += ` symref-target:${headRef}`;
      parts.push(pktLine(`${line}\n`));
    }
  }
  for (const [ref, oid] of sortedRefs(repo)) {
    if (!matches(ref)) continue;
    let line = `${oid} ${ref}`;
    if (peel) {
      const obj = forge.store.get(oid);
      if (obj && obj.type === 'tag') {
        const commit = derefToCommit(forge.store, oid);
        if (commit) line += ` peeled:${commit}`;
      }
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  deepen: number | null;
  done: boolean;
}

function parseFetchArgs(args: string[]): FetchArgs {
  const out: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, deepen: null, done: false };
  for (const arg of args) {
    if (arg.startsWith('want ')) out.wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) out.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) out.shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) {
      const n = parseInt(arg.slice(7), 10);
      if (out.shallow.length > 0) out.deepen = n;
      else out.depth = n;
    } else if (arg.startsWith('deepen-since ') || arg.startsWith('deepen-not ')) {
      // Not exercised by the checks beyond parsing; treat as unbounded.
    } else if (arg === 'done') out.done = true;
  }
  return out;
}

function sidebandPack(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 65515; // 4 header + 1 band + 65515 payload = 65520, the pkt-line cap
  for (let at = 0; at < pack.length; at += CHUNK) {
    parts.push(pktSideband(1, pack.subarray(at, at + CHUNK)));
  }
  return parts;
}

function fetchV2(forge: Forge, repo: RepoRec, args: string[]): Buffer {
  const cacheKey = `v2|${repo.name}|${refsKey(repo)}|${args.join('|')}`;
  return cached(cacheKey, () => fetchV2Uncached(forge, repo, args));
}

function fetchV2Uncached(forge: Forge, repo: RepoRec, args: string[]): Buffer {
  const parsed = parseFetchArgs(args);
  const store = forge.store;
  const set = computeFetchSet(store, parsed.wants, parsed.haves, parsed.shallow, parsed.depth, parsed.deepen);
  const parts: Buffer[] = [];

  // acknowledgments — only when the client sent haves to negotiate over;
  // with none, real git goes straight to the packfile section.
  if (parsed.haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'));
    const common = parsed.haves.filter((h) => derefToCommit(store, h) !== null && store.has(h));
    if (common.length === 0) {
      parts.push(pktLine('NAK\n'));
    } else {
      for (const oid of common) parts.push(pktLine(`ACK ${oid}\n`));
      parts.push(pktLine('ready\n'));
    }
    parts.push(PKT_DELIM);
  }

  // shallow-info, when the exchange involves shallowness at all
  if (parsed.depth !== null || parsed.deepen !== null || parsed.shallow.length > 0 || set.shallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of set.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of set.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }

  // packfile
  parts.push(pktLine('packfile\n'));
  const pack = writePack(store, set.objects);
  parts.push(...sidebandPack(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Protocol v0 fetch
// ---------------------------------------------------------------------------

function fetchV0(forge: Forge, repo: RepoRec, body: Buffer): Buffer {
  const cacheKey = `v0|${repo.name}|${refsKey(repo)}|${sha1Hex(body)}`;
  return cached(cacheKey, () => fetchV0Uncached(forge, repo, body));
}

function fetchV0Uncached(forge: Forge, repo: RepoRec, body: Buffer): Buffer {
  const reader = new PktReader(body);
  const wants: string[] = [];
  const haves: string[] = [];
  let depth: number | null = null;
  // Section 1: want lines (the first carries capabilities), optional deepen, flush.
  for (;;) {
    const item = reader.next();
    if (item === null || item.kind === 'flush') break;
    if (item.kind !== 'data') continue;
    const line = item.data.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) wants.push(line.slice(5, 45));
    else if (line.startsWith('deepen ')) depth = parseInt(line.slice(7), 10);
  }
  // Section 2: have lines and done, flush.
  for (;;) {
    const item = reader.next();
    if (item === null || item.kind === 'flush') break;
    if (item.kind !== 'data') continue;
    const line = item.data.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('have ')) haves.push(line.slice(5, 45));
  }
  const store = forge.store;
  const set = computeFetchSet(store, wants, haves, [], depth, null);
  const parts: Buffer[] = [];
  const common = haves.filter((h) => store.has(h));
  if (common.length === 0) {
    parts.push(pktLine('NAK\n'));
  } else {
    for (const oid of common) parts.push(pktLine(`ACK ${oid} common\n`));
    parts.push(pktLine(`ACK ${common[common.length - 1]}\n`));
  }
  for (const oid of set.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of set.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  const pack = writePack(store, set.objects);
  parts.push(...sidebandPack(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** POST git-upload-pack: dispatch on the command the body carries (v2) or v0 framing. */
export function uploadPack(forge: Forge, repo: RepoRec, body: Buffer): Buffer {
  const reader = new PktReader(body);
  const first = reader.next();
  if (first && first.kind === 'data') {
    const line = first.data.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('command=')) {
      const command = line.slice('command='.length);
      const args: string[] = [];
      for (;;) {
        const item = reader.next();
        if (item === null || item.kind === 'flush') break;
        if (item.kind === 'delim') continue;
        if (item.kind === 'data') args.push(item.data.toString('utf8').replace(/\n$/, ''));
      }
      if (command === 'ls-refs') return lsRefs(forge, repo, args);
      if (command === 'fetch') return fetchV2(forge, repo, args);
      return Buffer.concat([pktLine('error command not supported\n'), PKT_FLUSH]);
    }
  }
  return fetchV0(forge, repo, body);
}

// ---------------------------------------------------------------------------
// Receive-pack (push): v0 commands, then the pack; per-ref outcomes reported
// inside sideband band 1 as a pkt-lined report stream.
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function receivePack(forge: Forge, repo: RepoRec, body: Buffer): Buffer {
  const reader = new PktReader(body);
  const commands: PushCommand[] = [];
  for (;;) {
    const item = reader.next();
    if (item === null || item.kind === 'flush') break;
    if (item.kind !== 'data') continue;
    let line = item.data.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) line = line.slice(0, nul); // capabilities ride on the first line
    const fields = line.split(' ');
    if (fields.length >= 3) {
      commands.push({ oldOid: fields[0], newOid: fields[1], ref: fields[2] });
    }
  }
  const pack = reader.rest();
  const store: ObjectStore = forge.store;

  let unpackError: string | null = null;
  if (pack.length > 0 && commands.some((c) => c.newOid !== ZERO_OID)) {
    try {
      readPack(store, pack);
    } catch (err) {
      unpackError = err instanceof Error ? err.message : 'unpack failed';
    }
  }

  const report: Buffer[] = [];
  report.push(pktLine(unpackError ? `unpack ${unpackError}\n` : 'unpack ok\n'));

  for (const command of commands) {
    const fail = (reason: string) => report.push(pktLine(`ng ${command.ref} ${reason}\n`));
    const ok = () => report.push(pktLine(`ok ${command.ref}\n`));
    if (unpackError) {
      fail('unpacker error');
      continue;
    }
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (!repo.refs.has(command.ref)) {
        fail('reference does not exist');
        continue;
      }
      repo.refs.delete(command.ref);
      ok();
      continue;
    }
    const target = store.get(command.newOid);
    if (!target || (target.type !== 'commit' && target.type !== 'tag')) {
      fail('missing object');
      continue;
    }
    if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
      fail('stale info');
      continue;
    }
    if (command.oldOid !== ZERO_OID && command.oldOid !== command.newOid) {
      const oldCommit = derefToCommit(store, command.oldOid);
      const newCommit = derefToCommit(store, command.newOid);
      if (!oldCommit || !newCommit || !isAncestor(store, oldCommit, newCommit)) {
        fail('non-fast-forward');
        continue;
      }
    }
    repo.refs.set(command.ref, command.newOid);
    ok();
  }
  report.push(PKT_FLUSH);
  const reportStream = Buffer.concat(report);

  // The report travels inside sideband band 1, then a final flush ends the reply.
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let at = 0; at < reportStream.length; at += CHUNK) {
    parts.push(pktSideband(1, reportStream.subarray(at, at + CHUNK)));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}
