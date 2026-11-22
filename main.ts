// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** (old, new) of every move edit that succeeded, for the `R` line (section 2). */
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ---------------------------------------------------------------------------------------------------------------
 * Sections 3 and 5: the text of a file, and lines matched at three tiers.
 * ------------------------------------------------------------------------------------------------------------ */

/** A file's text as the spec reads it: its lines, its line break and whether it ends with one. */
interface Doc {
  lines: string[];
  br: string;
  final: boolean;
}

function toDoc(text: string): Doc {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

/** A file of no lines is written empty (section 3). */
const docText = (d: Doc): string => (d.lines.length === 0 ? '' : d.lines.join(d.br) + (d.final ? d.br : ''));

/** One line of a patch body: context ` `, old `-`, new `+` or a `\` marker. `pad` marks a blank patch line. */
interface Body {
  k: string;
  t: string;
  pad?: boolean;
}

const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0];

function tierEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return a.replace(/[ \t]+$/, '') === b.replace(/[ \t]+$/, '');
  return a.replace(/^[ \t]+|[ \t]+$/g, '') === b.replace(/^[ \t]+|[ \t]+$/g, '');
}

function matchAt(hay: string[], at: number, O: string[], tier: number): boolean {
  if (at < 0 || at + O.length > hay.length) return false;
  for (let j = 0; j < O.length; j++) if (!tierEq(hay[at + j]!, O[j]!, tier)) return false;
  return true;
}

function occurrences(hay: string[], O: string[], tier: number): number[] {
  const out: number[] = [];
  for (let i = 0; i + O.length <= hay.length; i++) if (matchAt(hay, i, O, tier)) out.push(i);
  return out;
}

const topTier = (strict: boolean): number => (strict ? 0 : 2);

/** O at the first tier it occurs at, with every occurrence there (section 5). */
function atFirstTier(hay: string[], O: string[], strict: boolean): { tier: number; pos: number[] } | null {
  for (let tier = 0; tier <= topTier(strict); tier++) {
    const pos = occurrences(hay, O, tier);
    if (pos.length > 0) return { tier, pos };
  }
  return null;
}

/** O's lines of a body: its context and `-` lines, in body order. */
const oldLines = (body: Body[]): string[] => body.filter((b) => b.k === ' ' || b.k === '-').map((b) => b.t);

const newCount = (body: Body[]): number => body.filter((b) => b.k === ' ' || b.k === '+').length;

/** A line of N at tier 2: its own indentation replaced by the file's (section 5). */
function reindent(line: string, from: string, to: string): string {
  if (line === '' || /^[ \t]+$/.test(line)) return line;
  if (!line.startsWith(from)) return line;
  return to + line.slice(from.length);
}

/** Replace k lines at `pos` by N: context lines from the file, the rest re-indented at tier 2 (section 5). */
function spliceBody(file: string[], pos: number, k: number, body: Body[], tier: number): string[] {
  const out = file.slice(0, pos);
  const firstO = body.find((b) => b.k === ' ' || b.k === '-');
  const P = firstO === undefined ? '' : leadWs(firstO.t);
  const F = leadWs(file[pos] ?? '');
  let oi = pos;
  for (const b of body) {
    if (b.k === ' ') out.push(file[oi++]!);
    else if (b.k === '-') oi += 1;
    else if (b.k === '+') out.push(tier === 2 ? reindent(b.t, P, F) : b.t);
  }
  out.push(...file.slice(pos + k));
  return out;
}

/** The hunk's last context or `+` line is followed by a `\` line: the result has no final break (section 6). */
function noEolAfter(body: Body[]): boolean {
  let last = -1;
  for (let i = 0; i < body.length; i++) if (body[i]!.k === ' ' || body[i]!.k === '+') last = i;
  return last >= 0 && body.slice(last + 1).some((b) => b.k === '\\');
}

/** A created file, from all its `+` lines: does the last of them carry a `\` line after it (section 6)? */
function createdNoEol(bodies: Body[][]): boolean {
  for (let h = bodies.length - 1; h >= 0; h--) {
    const body = bodies[h]!;
    let last = -1;
    for (let i = 0; i < body.length; i++) if (body[i]!.k === '+') last = i;
    if (last >= 0) return body.slice(last + 1).some((b) => b.k === '\\');
  }
  return false;
}

/** The body lines after a `@@` header, up to a section start or a line that is no body line (section 6). */
function readBody(lines: string[], at: number): { body: Body[]; next: number } {
  const body: Body[] = [];
  let i = at;
  while (i < lines.length) {
    const b = lines[i]!;
    if (b.startsWith('diff --git ') || (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '))) break;
    if (!(b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+' || b[0] === '\\')) break;
    body.push(b === '' ? { k: ' ', t: '', pad: true } : { k: b[0]!, t: b.slice(1) });
    i += 1;
  }
  while (body.length > 0 && body[body.length - 1]!.k === ' ' && body[body.length - 1]!.t === '') body.pop();
  return { body, next: i };
}

/* ---------------------------------------------------------------------------------------------------------------
 * Section 6: unified diffs.
 * ------------------------------------------------------------------------------------------------------------ */

interface Hunk {
  a: number;
  body: Body[];
}

interface Section {
  oldPath?: string | null;
  newPath?: string | null;
  renameFrom?: string;
  renameTo?: string;
  diffFrom?: string;
  diffTo?: string;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

const DIFF = /^diff --git a\/(.+) b\/(.+)$/;
const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

const stripAB = (p: string): string => (p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p);

/** A `--- `/`+++ ` path: the text up to a tab, spaces trimmed; `/dev/null` is no file (section 6). */
function headerPath(rest: string): string | null {
  const p = rest.split('\t')[0]!.trim();
  return p === '/dev/null' ? null : stripAB(p);
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const secs: Section[] = [];
  let cur: Section | null = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = DIFF.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = { diffFrom: m[1]!, diffTo: m[2]!, create: false, del: false, hunks: [] };
      secs.push(cur);
      i += 1;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('--- ')) {
        if (!(lines[i + 1] ?? '').startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        if (cur.oldPath !== undefined || cur.newPath !== undefined) {
          cur = { create: false, del: false, hunks: [] };
          secs.push(cur);
        }
        cur.oldPath = headerPath(line.slice(4));
        cur.newPath = headerPath(lines[i + 1]!.slice(4));
        i += 2;
        continue;
      }
      if (line.startsWith('rename from ')) {
        cur.renameFrom = line.slice(12).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renameTo = line.slice(10).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.create = true;
        i += 1;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.del = true;
        i += 1;
        continue;
      }
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const read = readBody(lines, i + 1);
      cur.hunks.push({ a: Number(m[1]), body: read.body });
      i = read.next;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      cur = { create: false, del: false, hunks: [] };
      secs.push(cur);
      cur.oldPath = headerPath(line.slice(4));
      cur.newPath = headerPath(lines[i + 1]!.slice(4));
      i += 2;
      continue;
    }
    i += 1;
  }
  const edits: Edit[] = [];
  for (const s of secs) {
    const oldP = s.oldPath !== undefined ? s.oldPath : s.renameFrom !== undefined ? s.renameFrom : s.diffFrom;
    const newP = s.newPath !== undefined ? s.newPath : s.renameTo !== undefined ? s.renameTo : s.diffTo;
    if (s.create || oldP === null) {
      if (newP === null || newP === undefined) continue;
      const target = newP;
      const bodies = s.hunks.map((h) => h.body);
      edits.push((tree) => {
        if (!safe(target)) throw new Fail('unsafe', target);
        if (tree.get(target) !== null) throw new Fail('exists', target);
        const made = bodies.flatMap((b) => b.filter((x) => x.k === '+').map((x) => x.t));
        tree.now.set(target, docText({ lines: made, br: '\n', final: !createdNoEol(bodies) }));
      });
      continue;
    }
    if (s.del || newP === null) {
      if (oldP === null || oldP === undefined) continue;
      const target = oldP;
      edits.push((tree) => {
        if (!safe(target)) throw new Fail('unsafe', target);
        if (tree.get(target) === null) throw new Fail('missing', target);
        tree.now.set(target, null);
      });
      continue;
    }
    if (oldP === undefined || newP === undefined) continue;
    const target = oldP;
    const moveTo = oldP === newP ? null : newP;
    const hunks = s.hunks;
    edits.push((tree) => {
      if (!safe(target)) throw new Fail('unsafe', target);
      if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
      const was = tree.get(target);
      if (was === null) throw new Fail('missing', target);
      if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
      const out = applyHunks(toDoc(was), hunks, strict, target);
      const text = docText(out);
      if (moveTo !== null) {
        tree.now.set(moveTo, text);
        tree.now.set(target, null);
        tree.moves.push([target, moveTo]);
      } else tree.now.set(target, text);
    });
  }
  return edits;
}

/** The hunks of one section, in order, each to the result of the ones before it (section 6). */
function applyHunks(doc: Doc, hunks: Hunk[], strict: boolean, path: string): Doc {
  let lines = doc.lines;
  let final = doc.final;
  let d = 0;
  for (const h of hunks) {
    const O = oldLines(h.body);
    const target = h.a - 1 + d;
    let pos: number;
    let tier = 0;
    if (O.length === 0) {
      pos = Math.max(0, Math.min(h.a + d, lines.length));
    } else {
      const found = atFirstTier(lines, O, strict);
      if (found === null) throw new Fail('no-match', path);
      tier = found.tier;
      pos = found.pos[0]!;
      for (const p of found.pos) {
        const dp = Math.abs(p - target);
        const db = Math.abs(pos - target);
        if (dp < db || (dp === db && p < pos)) pos = p;
      }
    }
    if (pos + O.length === lines.length) final = !noEolAfter(h.body);
    lines = spliceBody(lines, pos, O.length, h.body, tier);
    d += newCount(h.body) - O.length;
  }
  return { lines, br: doc.br, final };
}

/* ---------------------------------------------------------------------------------------------------------------
 * Section 7: SEARCH/REPLACE blocks.
 * ------------------------------------------------------------------------------------------------------------ */

const SEARCH_MARK = '<<<<<<< SEARCH';
const SEP_MARK = '=======';
const REPLACE_MARK = '>>>>>>> REPLACE';

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  let prevPath: string | null = null;
  let floor = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== SEARCH_MARK) {
      i += 1;
      continue;
    }
    const se = i;
    let path: string | null = null;
    for (let j = se - 1; j >= floor; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${se + 1}`);
    let sep = -1;
    for (let j = se + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === SEP_MARK) {
        sep = j;
        break;
      }
      if (t === REPLACE_MARK) break;
    }
    if (sep < 0) throw new Exit2(`error: parse ${se + 1}`);
    let rep = -1;
    for (let j = sep + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === REPLACE_MARK) {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${se + 1}`);
    const oldLs = lines.slice(se + 1, sep);
    const newLs = lines.slice(sep + 1, rep);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLs.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, docText({ lines: newLs, br: '\n', final: true }));
        return;
      }
      const was = tree.get(p);
      if (was === null) throw new Fail('missing', p);
      const doc = toDoc(was);
      const found = atFirstTier(doc.lines, oldLs, strict);
      if (found === null) throw new Fail('no-match', p);
      if (found.pos.length > 1) throw new Fail('ambiguous', p);
      const body: Body[] = [...oldLs.map((t) => ({ k: '-', t })), ...newLs.map((t) => ({ k: '+', t }))];
      tree.now.set(p, docText({ lines: spliceBody(doc.lines, found.pos[0]!, oldLs.length, body, found.tier), br: doc.br, final: doc.final }));
    });
    prevPath = path;
    floor = rep + 1;
    i = rep + 1;
  }
  return edits;
}

/* ---------------------------------------------------------------------------------------------------------------
 * Section 8: V4A patches.
 * ------------------------------------------------------------------------------------------------------------ */

interface Chunk {
  anchor: string | null;
  eof: boolean;
  body: Body[];
}

interface VSection {
  kind: string;
  path: string;
  moveTo: string | null;
  lines: string[];
  chunks: Chunk[];
}

/** The body of a V4A chunk: context ` `, old `-`, new `+`, blank; `*** End of File` ends it (section 8). */
function readChunk(lines: string[], at: number, last: number): { chunk: Body[]; eof: boolean; next: number } {
  const body: Body[] = [];
  let i = at;
  let eof = false;
  while (i < last) {
    const c = lines[i]!;
    if (c.trim() === '*** End of File') {
      eof = true;
      i += 1;
      break;
    }
    if (c.startsWith('@@') || c.startsWith('*** ')) break;
    if (!(c === '' || c[0] === ' ' || c[0] === '-' || c[0] === '+')) break;
    body.push(c === '' ? { k: ' ', t: '', pad: true } : { k: c[0]!, t: c.slice(1) });
    i += 1;
  }
  return { chunk: body, eof, next: i };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last > first && blank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const secs: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice(14).trim();
      const made: Array<{ t: string; pad: boolean }> = [];
      i += 1;
      while (i < last) {
        const b = lines[i]!;
        if (b.startsWith('*** ')) break;
        if (b === '') {
          made.push({ t: '', pad: true });
          i += 1;
          continue;
        }
        if (b[0] !== '+') throw new Exit2(`error: parse ${i + 1}`);
        made.push({ t: b.slice(1), pad: false });
        i += 1;
      }
      while (made.length > 0 && made[made.length - 1]!.pad) made.pop();
      secs.push({ kind: 'add', path, moveTo: null, lines: made.map((x) => x.t), chunks: [] });
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice(17).trim();
      i += 1;
      while (i < last) {
        if (blank(lines[i]!)) {
          i += 1;
          continue;
        }
        if (lines[i]!.startsWith('*** ')) break;
        throw new Exit2(`error: parse ${i + 1}`);
      }
      secs.push({ kind: 'delete', path, moveTo: null, lines: [], chunks: [] });
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice(17).trim();
      const start = i;
      i += 1;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice(13).trim();
        i += 1;
      }
      const chunks: Chunk[] = [];
      while (i < last) {
        const b = lines[i]!;
        if (b.startsWith('*** ')) break;
        if (b.startsWith('@@')) {
          const anchor = b.slice(2).trim();
          const read = readChunk(lines, i + 1, last);
          chunks.push({ anchor: anchor === '' ? null : anchor, eof: read.eof, body: read.chunk });
          i = read.next;
          continue;
        }
        if (b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+') {
          if (b === '') {
            let j = i;
            while (j < last && blank(lines[j]!)) j += 1;
            if (j >= last || lines[j]!.startsWith('*** ')) {
              i = j;
              break;
            }
          }
          const read = readChunk(lines, i, last);
          chunks.push({ anchor: null, eof: read.eof, body: read.chunk });
          i = read.next;
          continue;
        }
        break;
      }
      const lastChunk = chunks.length > 0 ? chunks[chunks.length - 1]! : null;
      while (lastChunk !== null && lastChunk.body.length > 0 && lastChunk.body[lastChunk.body.length - 1]!.k === ' ' && lastChunk.body[lastChunk.body.length - 1]!.t === '') {
        lastChunk.body.pop();
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${start + 1}`);
      secs.push({ kind: 'update', path, moveTo, lines: [], chunks });
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  const edits: Edit[] = [];
  for (const s of secs) {
    if (s.kind === 'add') {
      const p = s.path;
      const made = s.lines;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, docText({ lines: made, br: '\n', final: true }));
      });
      continue;
    }
    if (s.kind === 'delete') {
      const p = s.path;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
      continue;
    }
    const p = s.path;
    const moveTo = s.moveTo;
    const chunks = s.chunks;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
      const was = tree.get(p);
      if (was === null) throw new Fail('missing', p);
      if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
      const text = docText(applyChunks(toDoc(was), chunks, strict, p));
      if (moveTo !== null) {
        tree.now.set(moveTo, text);
        tree.now.set(p, null);
        tree.moves.push([p, moveTo]);
      } else tree.now.set(p, text);
    });
  }
  return edits;
}

/** A V4A Update File's chunks, with a cursor that starts at line 0 (section 8). */
function applyChunks(doc: Doc, chunks: Chunk[], strict: boolean, path: string): Doc {
  let lines = doc.lines;
  let cursor = 0;
  for (const ch of chunks) {
    if (ch.anchor !== null) {
      let found = -1;
      for (let tier = 0; tier <= topTier(strict) && found < 0; tier++) {
        for (let i = cursor; i < lines.length; i++) {
          if (tierEq(lines[i]!, ch.anchor, tier)) {
            found = i;
            break;
          }
        }
      }
      if (found < 0) throw new Fail('no-match', path);
      cursor = found + 1;
    }
    const O = oldLines(ch.body);
    let pos: number;
    let tier = 0;
    if (O.length === 0) {
      pos = ch.eof ? lines.length : cursor;
    } else {
      let found = -1;
      for (let t = 0; t <= topTier(strict) && found < 0; t++) {
        for (let i = cursor; i + O.length <= lines.length; i++) {
          if (ch.eof && i + O.length !== lines.length) continue;
          if (matchAt(lines, i, O, t)) {
            found = i;
            tier = t;
            break;
          }
        }
      }
      if (found < 0) throw new Fail('no-match', path);
      pos = found;
    }
    lines = spliceBody(lines, pos, O.length, ch.body, tier);
    cursor = pos + newCount(ch.body);
  }
  return { lines, br: doc.br, final: doc.final };
}

/* ---------------------------------------------------------------------------------------------------------------
 * Sections 1, 2 and 10: the command line, the output and the all-or-nothing write.
 * ------------------------------------------------------------------------------------------------------------ */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const kinds = new Map<string, string>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    kinds.set(p, was === null ? 'A' : now === null ? 'D' : 'M');
  }
  const rows: Array<{ key: string; line: string }> = [];
  const paired = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (kinds.get(oldP) === 'D' && kinds.get(newP) === 'A') {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      paired.add(oldP);
      paired.add(newP);
    }
  }
  for (const [p, k] of kinds) if (!paired.has(p)) rows.push({ key: p, line: `${k} ${p}` });
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const [p, k] of kinds) {
      if (k === 'D') rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, tree.now.get(p)!);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
