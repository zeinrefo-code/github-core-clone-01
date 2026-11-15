// The git object layer: a content-addressed store, tree/commit construction and
// parsing, reachability, packfiles and pkt-lines. Everything the forge serves —
// pushes, clones, REST contents writes, squash merges — is built on these
// primitives, and pushed objects are stored byte for byte as they arrived,
// because the suite's clone checks recompute every hash and compare commits
// exactly.
//
// Standard library only: node:crypto for SHA-1, node:zlib for pack streams.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

const TYPE_CODES: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export const ZERO_OID = '0'.repeat(40);

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The object id of a would-be object: SHA-1 over "<type> <size>\0" + bytes. */
export function hashObject(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

export class ObjectStore {
  private readonly objects = new Map<string, GitObject>();

  store(type: ObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  /** Store bytes already framed as an object payload of the given type (from a pack). */
  storeRaw(type: ObjectType, data: Buffer): string {
    return this.store(type, data);
  }

  get(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  has(oid: string): boolean {
    return this.objects.has(oid);
  }
}

// ---------------------------------------------------------------------------
// Trees
// ---------------------------------------------------------------------------

export interface TreeEntry {
  mode: string; // '40000' for directories, '100644' / '100755' / '120000' for files
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    const mode = data.toString('utf8', pos, space);
    const nul = data.indexOf(0x00, space + 1);
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    pos = nul + 21;
  }
  return entries;
}

/** Git's tree order: by name, with directory names compared as if they ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function serializeTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Commits
// ---------------------------------------------------------------------------

export interface Commit {
  tree: string;
  parents: string[];
  message: string;
  raw: Buffer;
}

export function parseCommit(data: Buffer): Commit {
  const blank = data.indexOf('\n\n');
  const headerText = data.toString('utf8', 0, blank < 0 ? data.length : blank);
  const message = blank < 0 ? '' : data.toString('utf8', blank + 2);
  let tree = '';
  const parents: string[] = [];
  for (const line of headerText.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return { tree, parents, message, raw: data };
}

export function buildCommitData(fields: {
  tree: string;
  parents: string[];
  message: string;
  authorLine: string;
}): Buffer {
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.authorLine}`);
  lines.push(`committer ${fields.authorLine}`);
  return Buffer.from(`${lines.join('\n')}\n\n${fields.message}`, 'utf8');
}

// ---------------------------------------------------------------------------
// Tree surgery: read a whole tree recursively, and write a path into a tree
// (creating intermediate trees, pruning ones a delete leaves empty).
// ---------------------------------------------------------------------------

/** Every file under a tree, as path -> {mode, oid}. */
export function flattenTree(store: ObjectStore, treeOid: string, prefix = ''): Map<string, { mode: string; oid: string }> {
  const out = new Map<string, { mode: string; oid: string }>();
  const obj = store.get(treeOid);
  if (!obj || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') {
      for (const [p, v] of flattenTree(store, entry.oid, path)) out.set(p, v);
    } else {
      out.set(path, { mode: entry.mode, oid: entry.oid });
    }
  }
  return out;
}

/** Look up one path in a tree: {mode, oid} of the file or subtree, or null. */
export function lookupPath(store: ObjectStore, treeOid: string, parts: string[]): { mode: string; oid: string } | null {
  let current = treeOid;
  for (let i = 0; i < parts.length; i++) {
    const obj = store.get(current);
    if (!obj || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((e) => e.name === parts[i]);
    if (!entry) return null;
    if (i === parts.length - 1) return { mode: entry.mode, oid: entry.oid };
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

/**
 * Return the oid of a new root tree with `parts` set to blobOid (or removed
 * when blobOid is null). Directories a removal empties are pruned; a root that
 * ends up empty yields the empty-tree oid when it is the root itself.
 */
export function updateTree(
  store: ObjectStore,
  rootOid: string | null,
  parts: string[],
  blobOid: string | null,
  mode = '100644',
): string {
  const EMPTY_TREE = store.store('tree', Buffer.alloc(0));
  function write(treeOid: string | null, depth: number): string | null {
    const entries: TreeEntry[] = treeOid ? parseTree(store.get(treeOid)?.data ?? Buffer.alloc(0)) : [];
    const name = parts[depth];
    const at = entries.findIndex((e) => e.name === name);
    if (depth === parts.length - 1) {
      if (blobOid === null) {
        if (at >= 0) entries.splice(at, 1);
      } else if (at >= 0) {
        entries[at] = { mode, name, oid: blobOid };
      } else {
        entries.push({ mode, name, oid: blobOid });
      }
    } else {
      const childOid = at >= 0 && entries[at].mode === '40000' ? entries[at].oid : null;
      const newChild = write(childOid, depth + 1);
      if (newChild === null) {
        if (at >= 0) entries.splice(at, 1);
      } else if (at >= 0) {
        entries[at] = { mode: '40000', name, oid: newChild };
      } else {
        entries.push({ mode: '40000', name, oid: newChild });
      }
    }
    if (entries.length === 0) return depth === 0 ? EMPTY_TREE : null;
    return store.store('tree', serializeTree(entries));
  }
  return write(rootOid, 0) ?? EMPTY_TREE;
}

// ---------------------------------------------------------------------------
// Reachability over the commit graph.
// ---------------------------------------------------------------------------

/** All commits reachable from the given tips, tips included. */
export function commitClosure(store: ObjectStore, tips: string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const obj = store.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    seen.add(oid);
    for (const parent of parseCommit(obj.data).parents) stack.push(parent);
  }
  return seen;
}

export function isAncestor(store: ObjectStore, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  return commitClosure(store, [tip]).has(ancestor);
}

/** A merge-base of two tips: a common ancestor that is not an ancestor of another common ancestor. */
export function mergeBase(store: ObjectStore, a: string, b: string): string | null {
  const fromA = commitClosure(store, [a]);
  const seen = new Set<string>();
  const queue = [b];
  const candidates: string[] = [];
  while (queue.length) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = store.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    if (fromA.has(oid)) candidates.push(oid);
    for (const parent of parseCommit(obj.data).parents) queue.push(parent);
  }
  for (const candidate of candidates) {
    const shadowed = candidates.some(
      (other) => other !== candidate && isAncestor(store, candidate, other),
    );
    if (!shadowed) return candidate;
  }
  return candidates[0] ?? null;
}

/** Every object (commits, trees, blobs, tags) reachable from the given object ids. */
export function objectClosure(store: ObjectStore, tips: string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const obj = store.get(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      stack.push(commit.tree, ...commit.parents);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) stack.push(entry.oid);
    } else if (obj.type === 'tag') {
      const match = /^object ([0-9a-f]{40})/m.exec(obj.data.toString('utf8'));
      if (match) stack.push(match[1]);
    }
  }
  return seen;
}

// ---------------------------------------------------------------------------
// The fetch object set (spec §2.4): the closure of the wants minus what the
// haves already cover, with shallow/deepen handled as depth limits over the
// commit graph.
// ---------------------------------------------------------------------------

export interface FetchSet {
  /** Object ids to pack, in a deterministic order (commits newest-first, then the rest). */
  objects: string[];
  /** Commits to declare shallow: sent commits whose parents were not sent. */
  shallow: string[];
  /** Previously shallow commits whose parents are all included now. */
  unshallow: string[];
}

export function computeFetchSet(
  store: ObjectStore,
  wants: string[],
  haves: string[],
  shallowOids: string[],
  depth: number | null, // fresh-fetch depth (deepen N on an unshallowed client)
  deepen: number | null, // deepen an already-shallow client by N
): FetchSet {
  // Depth of every commit reachable from the wants (BFS, parents in order).
  const depthOf = new Map<string, number>();
  const queue: Array<[string, number]> = [];
  for (const want of wants) {
    const target = derefToCommit(store, want);
    if (target && !depthOf.has(target)) queue.push([target, 0]);
  }
  while (queue.length) {
    const [oid, d] = queue.shift() as [string, number];
    if (depthOf.has(oid) && (depthOf.get(oid) as number) <= d) continue;
    depthOf.set(oid, d);
    const obj = store.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) queue.push([parent, d + 1]);
  }

  // What the client already holds: the full closure of its haves — except a
  // have that is also a shallow boundary, which the client holds WITHOUT its
  // ancestry (that is what shallow means). Boundary commits contribute
  // themselves and their trees only.
  const shallowCommits = new Set<string>();
  for (const oid of shallowOids) {
    const commit = derefToCommit(store, oid);
    if (commit) shallowCommits.add(commit);
  }
  const possessedObjects = new Set<string>();
  const possessedCommits = new Set<string>();
  const holdShallow = (commit: string) => {
    possessedCommits.add(commit);
    possessedObjects.add(commit);
    const parsed = parseCommit((store.get(commit) as GitObject).data);
    for (const o of objectClosure(store, [parsed.tree])) possessedObjects.add(o);
  };
  for (const have of haves) {
    const commit = derefToCommit(store, have);
    if (commit && shallowCommits.has(commit)) {
      holdShallow(commit);
    } else {
      for (const c of commitClosure(store, [have])) possessedCommits.add(c);
      for (const o of objectClosure(store, [have])) possessedObjects.add(o);
    }
  }
  for (const commit of shallowCommits) holdShallow(commit);

  // The depth limit for commits to send. On the wire, deepen carries the
  // TOTAL depth wanted from the want tips (deepen 2 on a depth-1 clone asks
  // for exactly one more generation), same as a fresh fetch's depth.
  let limit = Number.POSITIVE_INFINITY;
  const wantedDepth = depth !== null ? depth : deepen;
  if (wantedDepth !== null) limit = wantedDepth - 1;

  const sentCommits: string[] = [];
  for (const [oid, d] of depthOf) {
    if (d > limit) continue;
    if (possessedCommits.has(oid)) continue;
    sentCommits.push(oid);
  }
  sentCommits.sort((a, b) => (depthOf.get(a) as number) - (depthOf.get(b) as number));

  const sentSet = new Set(sentCommits);
  const shallow: string[] = [];
  const unshallow: string[] = [];
  for (const oid of sentCommits) {
    const parsed = parseCommit((store.get(oid) as GitObject).data);
    if (parsed.parents.some((p) => !sentSet.has(p) && !possessedCommits.has(p))) shallow.push(oid);
  }
  for (const oid of shallowOids) {
    const commit = derefToCommit(store, oid);
    if (!commit) continue;
    const parsed = parseCommit((store.get(commit) as GitObject).data);
    if (parsed.parents.every((p) => sentSet.has(p) || possessedCommits.has(p))) unshallow.push(commit);
  }

  // Trees and blobs of the sent commits that the client does not already
  // hold. Only each commit's own tree closure — following parents here would
  // leak history into shallow fetches.
  const packObjects = new Set<string>(sentCommits);
  for (const oid of sentCommits) {
    const tree = parseCommit((store.get(oid) as GitObject).data).tree;
    for (const o of objectClosure(store, [tree])) {
      if (!possessedObjects.has(o)) packObjects.add(o);
    }
  }
  // Tag objects named directly as wants travel too.
  for (const want of wants) {
    if (store.has(want) && !possessedObjects.has(want)) packObjects.add(want);
  }
  const rest = [...packObjects].filter((o) => !sentSet.has(o)).sort();
  return { objects: [...sentCommits, ...rest], shallow, unshallow };
}

/** Follow a tag object (or a commit) to the commit it names; commits map to themselves. */
export function derefToCommit(store: ObjectStore, oid: string): string | null {
  let current = oid;
  for (let i = 0; i < 8; i++) {
    const obj = store.get(current);
    if (!obj) return null;
    if (obj.type === 'commit') return current;
    if (obj.type === 'tag') {
      const match = /^object ([0-9a-f]{40})/m.exec(obj.data.toString('utf8'));
      if (!match) return null;
      current = match[1];
      continue;
    }
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Packfiles: plain-object writing (0 deltas is a passing answer), and a
// reader that also resolves ofs/ref deltas so real git pushes unpack.
// ---------------------------------------------------------------------------

export function writePack(store: ObjectStore, oids: string[]): Buffer {
  const present = oids.filter((oid) => store.has(oid));
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(present.length, 8);
  const parts: Buffer[] = [header];
  for (const oid of present) {
    const obj = store.get(oid);
    if (!obj) continue;
    const code = TYPE_CODES[obj.type];
    let size = obj.data.length;
    const first = size >= 16 ? 0x80 : 0;
    const headBytes: number[] = [first | (code << 4) | (size & 0x0f)];
    size >>= 4;
    while (size > 0) {
      let byte = size & 0x7f;
      size >>= 7;
      if (size > 0) byte |= 0x80;
      headBytes.push(byte);
    }
    parts.push(Buffer.from(headBytes));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

function readVarint(data: Buffer, pos: number): [number, number] {
  let value = 0;
  let shift = 0;
  for (;;) {
    const byte = data[pos++];
    value |= (byte & 0x7f) << shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
  }
  return [value, pos];
}

/** Apply a git delta (as carried by ofs/ref-delta objects) to a base payload. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  let sourceSize: number;
  [sourceSize, pos] = readVarint(delta, pos);
  let targetSize: number;
  [targetSize, pos] = readVarint(delta, pos);
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out: Buffer[] = [];
  let produced = 0;
  while (pos < delta.length) {
    const op = delta[pos++];
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i++) if (op & (1 << i)) offset |= delta[pos++] << (8 * i);
      for (let i = 0; i < 3; i++) if (op & (0x10 << i)) size |= delta[pos++] << (8 * i);
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op > 0) {
      out.push(delta.subarray(pos, pos + op));
      produced += op;
      pos += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (produced !== targetSize || result.length !== targetSize) throw new Error('delta target size mismatch');
  return result;
}

/**
 * The byte length of the zlib stream starting at `pos` whose inflated size is
 * `expectedSize`. inflateSync ignores trailing bytes and throws on a
 * truncated stream, so the smallest slice that inflates to exactly the
 * expected size is the stream's true end (binary search).
 */
function zlibStreamLength(pack: Buffer, pos: number, expectedSize: number): number {
  const remaining = pack.length - pos;
  // inflateSync ignores bytes past the stream's end and throws on a
  // truncated stream, so "inflates to exactly expectedSize" is monotone in
  // the slice length: false below the true end, true at and above it.
  const ok = (len: number): boolean => {
    try {
      return inflateSync(pack.subarray(pos, pos + len)).length === expectedSize;
    } catch {
      return false;
    }
  };
  // Bracket the end: probe upward from a first guess (a deflated object is
  // rarely larger than its plain size plus slack) until inflation succeeds.
  let lo = 1;
  let hi = Math.min(remaining, Math.max(16, expectedSize + 128));
  while (!ok(hi)) {
    if (hi >= remaining) throw new Error('corrupt zlib stream in pack');
    lo = hi + 1;
    hi = Math.min(remaining, hi * 2);
  }
  // Binary search for the minimal working length inside the bracket.
  let answer = hi;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ok(mid)) {
      answer = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return answer;
}

/** Unpack a pack into the store; returns the number of objects stored. Throws on a bad pack. */
export function readPack(store: ObjectStore, pack: Buffer): number {
  if (pack.length < 12 || pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a pack');
  const count = pack.readUInt32BE(8);
  let pos = 12;
  const byStart = new Map<number, GitObject>();
  const pending: GitObject[] = [];
  for (let i = 0; i < count; i++) {
    const start = pos;
    let byte = pack[pos++];
    const code = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[pos++];
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let base: GitObject | undefined;
    if (code === 6) {
      // ofs-delta: a negative offset back to the base object's start in this pack
      let offsetByte = pack[pos++];
      let offset = offsetByte & 0x7f;
      while (offsetByte & 0x80) {
        offsetByte = pack[pos++];
        offset = ((offset + 1) << 7) | (offsetByte & 0x7f);
      }
      base = byStart.get(start - offset);
      if (!base) throw new Error('ofs-delta base missing');
    } else if (code === 7) {
      const baseOid = pack.toString('hex', pos, pos + 20);
      pos += 20;
      base = store.get(baseOid) ?? pending.find((o) => hashObject(o.type, o.data) === baseOid);
      if (!base) throw new Error('ref-delta base missing');
    }
    const streamLength = zlibStreamLength(pack, pos, size);
    const inflated = inflateSync(pack.subarray(pos, pos + streamLength));
    pos += streamLength;
    let obj: GitObject;
    if (code === 6 || code === 7) {
      obj = { type: (base as GitObject).type, data: applyDelta((base as GitObject).data, inflated) };
    } else {
      const type = CODE_TYPES[code];
      if (!type) throw new Error(`bad pack object type ${code}`);
      obj = { type, data: inflated };
    }
    byStart.set(start, obj);
    pending.push(obj);
  }
  for (const obj of pending) store.store(obj.type, obj.data);
  return pending.length;
}

// ---------------------------------------------------------------------------
// pkt-lines
// ---------------------------------------------------------------------------

export function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

/** A sideband packet: band byte + payload, framed as one pkt-line. */
export function pktSideband(band: number, payload: Buffer): Buffer {
  return pktLine(Buffer.concat([Buffer.from([band]), payload]));
}

export type PktItem =
  | { kind: 'data'; data: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

export class PktReader {
  private pos = 0;
  private readonly buffer: Buffer;
  constructor(buffer: Buffer) {
    this.buffer = buffer;
  }

  /** The next item, or null when the buffer is exhausted. */
  next(): PktItem | null {
    if (this.pos >= this.buffer.length) return null;
    if (this.pos + 4 > this.buffer.length) throw new Error('truncated pkt-line header');
    const header = this.buffer.toString('ascii', this.pos, this.pos + 4);
    const length = parseInt(header, 16);
    if (Number.isNaN(length)) throw new Error(`bad pkt-line header ${header}`);
    if (length === 0) {
      this.pos += 4;
      return { kind: 'flush' };
    }
    if (length === 1) {
      this.pos += 4;
      return { kind: 'delim' };
    }
    if (length === 2) {
      this.pos += 4;
      return { kind: 'response-end' };
    }
    if (length === 3) throw new Error('pkt-line 0003 is invalid');
    if (this.pos + length > this.buffer.length) throw new Error('truncated pkt-line');
    const data = this.buffer.subarray(this.pos + 4, this.pos + length);
    this.pos += length;
    return { kind: 'data', data };
  }

  /** Everything not yet consumed (the pack after a receive-pack command block). */
  rest(): Buffer {
    return this.buffer.subarray(this.pos);
  }
}
