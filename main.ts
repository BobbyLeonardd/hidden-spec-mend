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
  /** Moves that succeeded, as (old, new), for the `R` lines of section 2. */
  readonly moved: Array<[string, string]> = [];
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

const MARK = '*** ';

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === MARK + 'Begin Patch') return 'v4a';
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

// ---- Text, and the three levels a line is matched at (sections 3 and 5) ----

/** A file's text: its rows, its break and whether it ends with one. */
interface Text {
  rows: string[];
  brk: string;
  tail: boolean;
}

const textOf = (raw: string): Text => {
  if (raw === '') return { rows: [], brk: '\n', tail: false };
  const cut = raw.indexOf('\n');
  const brk = cut > 0 && raw[cut - 1] === '\r' ? '\r\n' : '\n';
  const rows = raw.split(brk);
  const tail = raw.endsWith(brk);
  if (tail) rows.pop();
  return { rows, brk, tail };
};

/** A file of no rows is written empty (section 3). */
const strOf = (t: Text): string => (t.rows.length === 0 ? '' : t.rows.join(t.brk) + (t.tail ? t.brk : ''));

/** One row of a patch body: `k` is the marker, `s` the text after it. */
interface Row {
  k: string;
  s: string;
}

const indent = (s: string): string => /^[ \t]*/.exec(s)![0];

const sameLine = (a: string, b: string, lv: number): boolean =>
  lv === 0 ? a === b : lv === 1 ? a.replace(/[ \t]+$/, '') === b.replace(/[ \t]+$/, '') : a.replace(/^[ \t]+|[ \t]+$/g, '') === b.replace(/^[ \t]+|[ \t]+$/g, '');

function hitAt(rows: string[], old: string[], i: number, lv: number): boolean {
  if (i < 0 || i + old.length > rows.length) return false;
  for (let j = 0; j < old.length; j += 1) {
    if (!sameLine(rows[i + j]!, old[j]!, lv)) return false;
  }
  return true;
}

const hitsIn = (rows: string[], old: string[], lv: number): number[] => {
  const out: number[] = [];
  for (let i = 0; i <= rows.length - old.length; i += 1) {
    if (hitAt(rows, old, i, lv)) out.push(i);
  }
  return out;
};

const topLevel = (strict: boolean): number => (strict ? 0 : 2);

/** Every hit at the first level the old side occurs at (section 5). */
function tierHits(rows: string[], old: string[], strict: boolean): { lv: number; at: number[] } | null {
  for (let lv = 0; lv <= topLevel(strict); lv += 1) {
    const at = hitsIn(rows, old, lv);
    if (at.length !== 0) return { lv, at };
  }
  return null;
}

const oldRows = (body: Row[]): string[] => body.filter((r) => r.k === ' ' || r.k === '-').map((r) => r.s);
const newLen = (body: Row[]): number => body.filter((r) => r.k === ' ' || r.k === '+').length;

/** One row of the new side at level 2: its indentation swapped for the file's (section 5). */
function align(row: string, from: string, to: string): string {
  if (row === '' || /^[ \t]+$/.test(row) || !row.startsWith(from)) return row;
  return to + row.slice(from.length);
}

/** Swap k rows at `at` for the new side: context from the file, the rest aligned at level 2. */
function splice(rows: string[], at: number, k: number, body: Row[], lv: number): string[] {
  const out = rows.slice(0, at);
  const head = body.find((r) => r.k === ' ' || r.k === '-');
  const from = head === undefined ? '' : indent(head.s);
  const to = indent(rows[at] ?? '');
  let oi = at;
  for (const r of body) {
    if (r.k === ' ') {
      out.push(rows[oi]!);
      oi += 1;
    } else if (r.k === '-') {
      oi += 1;
    } else if (r.k === '+') {
      out.push(lv === 2 ? align(r.s, from, to) : r.s);
    }
  }
  return [...out, ...rows.slice(at + k)];
}

/** True when a `\` row follows the last context or `+` row of this body (section 6). */
function openEnded(body: Row[]): boolean {
  let last = -1;
  body.forEach((r, i) => {
    if (r.k === ' ' || r.k === '+') last = i;
  });
  if (last < 0) return false;
  return body.slice(last + 1).some((r) => r.k === '\\');
}

/** The rows after a `@@` header, to a section start or a row no body carries (section 6). */
function bodyAt(lines: string[], at: number): { body: Row[]; next: number } {
  const body: Row[] = [];
  let i = at;
  while (i < lines.length) {
    const row = lines[i]!;
    const startsSection = row.startsWith('diff --git ') || (row.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '));
    const isBody = row === '' || row.startsWith(' ') || row.startsWith('-') || row.startsWith('+') || row.startsWith('\\');
    if (startsSection || !isBody) break;
    body.push(row === '' ? { k: ' ', s: '' } : { k: row[0]!, s: row.slice(1) });
    i += 1;
  }
  while (body.length !== 0 && body[body.length - 1]!.k === ' ' && body[body.length - 1]!.s === '') body.pop();
  return { body, next: i };
}

// ---- Section 6: unified diffs ----

interface Hunk {
  a: number;
  body: Row[];
}

interface Section {
  oldPath?: string | null;
  newPath?: string | null;
  renameFrom?: string;
  renameTo?: string;
  diffFrom?: string;
  diffTo?: string;
  add: boolean;
  del: boolean;
  hunks: Hunk[];
}

const GIT_LINE = /^diff --git a\/(.+) b\/(.+)$/;
const AT_LINE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

const stripSide = (p: string): string => (p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p);

/** A `--- `/`+++ ` path: up to the first tab, spaces trimmed; `/dev/null` is no file (section 6). */
function headPath(rest: string): string | null {
  const p = rest.split('\t')[0]!.trim();
  return p === '/dev/null' ? null : stripSide(p);
}

function unified(lines: string[], strict: boolean): Edit[] {
  const secs: Section[] = [];
  let cur: Section | null = null;
  let i = 0;
  while (i < lines.length) {
    const row = lines[i]!;
    if (row.startsWith('diff --git ')) {
      const m = GIT_LINE.exec(row);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = { diffFrom: m[1]!, diffTo: m[2]!, add: false, del: false, hunks: [] };
      secs.push(cur);
      i += 1;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (row.startsWith('--- ')) {
        if (!(lines[i + 1] ?? '').startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        if (cur.oldPath !== undefined || cur.newPath !== undefined) {
          cur = { add: false, del: false, hunks: [] };
          secs.push(cur);
        }
        cur.oldPath = headPath(row.slice(4));
        cur.newPath = headPath(lines[i + 1]!.slice(4));
        i += 2;
        continue;
      }
      if (row.startsWith('rename from ')) {
        cur.renameFrom = row.slice(12).trim();
        i += 1;
        continue;
      }
      if (row.startsWith('rename to ')) {
        cur.renameTo = row.slice(10).trim();
        i += 1;
        continue;
      }
      if (row.startsWith('new file mode')) {
        cur.add = true;
        i += 1;
        continue;
      }
      if (row.startsWith('deleted file mode')) {
        cur.del = true;
        i += 1;
        continue;
      }
    }
    if (row.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = AT_LINE.exec(row);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const read = bodyAt(lines, i + 1);
      cur.hunks.push({ a: Number(m[1]), body: read.body });
      i = read.next;
      continue;
    }
    if (row.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      cur = { add: false, del: false, hunks: [] };
      secs.push(cur);
      cur.oldPath = headPath(row.slice(4));
      cur.newPath = headPath(lines[i + 1]!.slice(4));
      i += 2;
      continue;
    }
    i += 1;
  }
  const edits: Edit[] = [];
  for (const s of secs) {
    const from = s.oldPath !== undefined ? s.oldPath : s.renameFrom !== undefined ? s.renameFrom : s.diffFrom;
    const to = s.newPath !== undefined ? s.newPath : s.renameTo !== undefined ? s.renameTo : s.diffTo;
    if (s.add || from === null) {
      if (to === null || to === undefined) continue;
      const target = to;
      const bodies = s.hunks.map((h) => h.body);
      edits.push((tree) => {
        if (!safe(target)) throw new Fail('unsafe', target);
        if (tree.get(target) !== null) throw new Fail('exists', target);
        const made: string[] = [];
        for (const body of bodies) for (const r of body) if (r.k === '+') made.push(r.s);
        tree.now.set(target, strOf({ rows: made, brk: '\n', tail: !bodies.some((b) => openEnded(b)) }));
      });
      continue;
    }
    if (s.del || to === null) {
      if (from === null || from === undefined) continue;
      const target = from;
      edits.push((tree) => {
        if (!safe(target)) throw new Fail('unsafe', target);
        if (tree.get(target) === null) throw new Fail('missing', target);
        tree.now.set(target, null);
      });
      continue;
    }
    if (from === undefined || to === undefined) continue;
    const target = from;
    const dest = from === to ? null : to;
    const hunks = s.hunks;
    edits.push((tree) => {
      if (!safe(target)) throw new Fail('unsafe', target);
      if (dest !== null && !safe(dest)) throw new Fail('unsafe', dest);
      const was = tree.get(target);
      if (was === null) throw new Fail('missing', target);
      if (dest !== null && tree.get(dest) !== null) throw new Fail('exists', dest);
      const out = strOf(applyHunks(textOf(was), hunks, strict, target));
      if (dest === null) {
        tree.now.set(target, out);
        return;
      }
      tree.now.set(dest, out);
      tree.now.set(target, null);
      tree.moved.push([target, dest]);
    });
  }
  return edits;
}

/** A section's hunks, in order, each to what the ones before it left (section 6). */
function applyHunks(t: Text, hunks: Hunk[], strict: boolean, path: string): Text {
  let rows = t.rows;
  let tail = t.tail;
  let shift = 0;
  for (const h of hunks) {
    const old = oldRows(h.body);
    const want = h.a - 1 + shift;
    let at = 0;
    let lv = 0;
    if (old.length === 0) {
      at = Math.max(0, Math.min(h.a + shift, rows.length));
    } else {
      const found = tierHits(rows, old, strict);
      if (found === null) throw new Fail('no-match', path);
      lv = found.lv;
      at = found.at[0]!;
      for (const p of found.at) {
        const away = Math.abs(p - want);
        const best = Math.abs(at - want);
        if (away < best || (away === best && p < at)) at = p;
      }
    }
    if (at + old.length === rows.length) tail = !openEnded(h.body);
    rows = splice(rows, at, old.length, h.body, lv);
    shift += newLen(h.body) - old.length;
  }
  return { rows, brk: t.brk, tail };
}

// ---- Section 7: SEARCH/REPLACE blocks ----

const ASK = '<<<<<<< SEARCH';
const DIVIDE = '=======';
const ANSWER = '>>>>>>> REPLACE';

function searchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  let picked: string | null = null;
  let floor = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== ASK) {
      i += 1;
      continue;
    }
    const ask = i;
    let path: string | null = null;
    for (let j = ask - 1; j >= floor; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = picked;
    if (path === null) throw new Exit2(`error: parse ${ask + 1}`);
    let mid = -1;
    for (let j = ask + 1; j < lines.length; j += 1) {
      const t = lines[j]!.trimEnd();
      if (t === DIVIDE) {
        mid = j;
        break;
      }
      if (t === ANSWER) break;
    }
    if (mid < 0) throw new Exit2(`error: parse ${ask + 1}`);
    let close = -1;
    for (let j = mid + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === ANSWER) {
        close = j;
        break;
      }
    }
    if (close < 0) throw new Exit2(`error: parse ${ask + 1}`);
    const olds = lines.slice(ask + 1, mid);
    const news = lines.slice(mid + 1, close);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (olds.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, strOf({ rows: news, brk: '\n', tail: true }));
        return;
      }
      const was = tree.get(p);
      if (was === null) throw new Fail('missing', p);
      const t = textOf(was);
      const found = tierHits(t.rows, olds, strict);
      if (found === null) throw new Fail('no-match', p);
      if (found.at.length > 1) throw new Fail('ambiguous', p);
      const body: Row[] = [];
      for (const s of olds) body.push({ k: '-', s });
      for (const s of news) body.push({ k: '+', s });
      tree.now.set(p, strOf({ rows: splice(t.rows, found.at[0]!, olds.length, body, found.lv), brk: t.brk, tail: t.tail }));
    });
    picked = path;
    floor = close + 1;
    i = close + 1;
  }
  return edits;
}

// ---- Section 8: V4A patches ----

interface Chunk {
  anchor: string | null;
  eof: boolean;
  body: Row[];
}

interface Block {
  kind: string;
  path: string;
  dest: string | null;
  rows: string[];
  chunks: Chunk[];
}

/** A chunk's rows: context, old, new, blank; an end-of-file line ends it and pins it to the end. */
function chunkAt(lines: string[], at: number, last: number): { body: Row[]; eof: boolean; next: number } {
  const body: Row[] = [];
  let i = at;
  let eof = false;
  while (i < last) {
    const row = lines[i]!;
    if (row.trim() === MARK + 'End of File') {
      eof = true;
      i += 1;
      break;
    }
    if (row.startsWith('@@') || row.startsWith(MARK)) break;
    const isBody = row === '' || row.startsWith(' ') || row.startsWith('-') || row.startsWith('+');
    if (!isBody) break;
    body.push(row === '' ? { k: ' ', s: '' } : { k: row[0]!, s: row.slice(1) });
    i += 1;
  }
  return { body, eof, next: i };
}

function v4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== MARK + 'Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last > first && blank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== MARK + 'End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const blocks: Block[] = [];
  let i = first + 1;
  while (i < last) {
    const row = lines[i]!;
    if (blank(row)) {
      i += 1;
      continue;
    }
    if (row.startsWith(MARK + 'Add File: ')) {
      const path = row.slice((MARK + 'Add File: ').length).trim();
      const kept: string[] = [];
      let pad = 0;
      i += 1;
      while (i < last) {
        const b = lines[i]!;
        if (b.startsWith(MARK)) break;
        if (b === '') {
          kept.push('');
          pad += 1;
          i += 1;
          continue;
        }
        if (!b.startsWith('+')) throw new Exit2(`error: parse ${i + 1}`);
        kept.push(b.slice(1));
        pad = 0;
        i += 1;
      }
      while (pad > 0) {
        kept.pop();
        pad -= 1;
      }
      blocks.push({ kind: 'add', path, dest: null, rows: kept, chunks: [] });
      continue;
    }
    if (row.startsWith(MARK + 'Delete File: ')) {
      const path = row.slice((MARK + 'Delete File: ').length).trim();
      i += 1;
      while (i < last) {
        if (blank(lines[i]!)) {
          i += 1;
          continue;
        }
        if (lines[i]!.startsWith(MARK)) break;
        throw new Exit2(`error: parse ${i + 1}`);
      }
      blocks.push({ kind: 'delete', path, dest: null, rows: [], chunks: [] });
      continue;
    }
    if (row.startsWith(MARK + 'Update File: ')) {
      const path = row.slice((MARK + 'Update File: ').length).trim();
      const opened = i;
      i += 1;
      let dest: string | null = null;
      if (i < last && lines[i]!.startsWith(MARK + 'Move to: ')) {
        dest = lines[i]!.slice((MARK + 'Move to: ').length).trim();
        i += 1;
      }
      const chunks: Chunk[] = [];
      while (i < last) {
        const b = lines[i]!;
        if (b.startsWith(MARK)) break;
        if (b.startsWith('@@')) {
          const anchor = b.slice(2).trim();
          const read = chunkAt(lines, i + 1, last);
          chunks.push({ anchor: anchor === '' ? null : anchor, eof: read.eof, body: read.body });
          i = read.next;
          continue;
        }
        const isBody = b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+');
        if (!isBody) break;
        if (b === '') {
          let j = i;
          while (j < last && blank(lines[j]!)) j += 1;
          if (j >= last || lines[j]!.startsWith(MARK)) {
            i = j;
            break;
          }
        }
        const read = chunkAt(lines, i, last);
        chunks.push({ anchor: null, eof: read.eof, body: read.body });
        i = read.next;
      }
      const tailChunk = chunks.at(-1);
      if (tailChunk !== undefined) {
        while (tailChunk.body.length !== 0 && tailChunk.body[tailChunk.body.length - 1]!.k === ' ' && tailChunk.body[tailChunk.body.length - 1]!.s === '') tailChunk.body.pop();
      }
      if (chunks.length === 0 && dest === null) throw new Exit2(`error: parse ${opened + 1}`);
      blocks.push({ kind: 'update', path, dest, rows: [], chunks });
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  const edits: Edit[] = [];
  for (const b of blocks) {
    if (b.kind === 'add') {
      const p = b.path;
      const made = b.rows;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, strOf({ rows: made, brk: '\n', tail: true }));
      });
      continue;
    }
    if (b.kind === 'delete') {
      const p = b.path;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
      continue;
    }
    const p = b.path;
    const dest = b.dest;
    const chunks = b.chunks;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (dest !== null && !safe(dest)) throw new Fail('unsafe', dest);
      const was = tree.get(p);
      if (was === null) throw new Fail('missing', p);
      if (dest !== null && tree.get(dest) !== null) throw new Fail('exists', dest);
      const out = strOf(applyChunks(textOf(was), chunks, strict, p));
      if (dest === null) {
        tree.now.set(p, out);
        return;
      }
      tree.now.set(dest, out);
      tree.now.set(p, null);
      tree.moved.push([p, dest]);
    });
  }
  return edits;
}

/** A V4A update's chunks, with a cursor that starts at row 0 (section 8). */
function applyChunks(t: Text, chunks: Chunk[], strict: boolean, path: string): Text {
  let rows = t.rows;
  let cursor = 0;
  for (const c of chunks) {
    if (c.anchor !== null) {
      const anchor = c.anchor;
      let found = -1;
      for (let lv = 0; lv <= topLevel(strict) && found < 0; lv += 1) {
        for (let i = cursor; i < rows.length; i += 1) {
          if (sameLine(rows[i]!, anchor, lv)) {
            found = i;
            break;
          }
        }
      }
      if (found < 0) throw new Fail('no-match', path);
      cursor = found + 1;
    }
    const old = oldRows(c.body);
    let at = 0;
    let lv = 0;
    if (old.length === 0) {
      at = c.eof ? rows.length : cursor;
    } else {
      let found = -1;
      for (let level = 0; level <= topLevel(strict) && found < 0; level += 1) {
        for (let i = cursor; i + old.length <= rows.length; i += 1) {
          if (c.eof && i + old.length !== rows.length) continue;
          if (hitAt(rows, old, i, level)) {
            found = i;
            lv = level;
            break;
          }
        }
      }
      if (found < 0) throw new Fail('no-match', path);
      at = found;
    }
    rows = splice(rows, at, old.length, c.body, lv);
    cursor = at + newLen(c.body);
  }
  return { rows, brk: t.brk, tail: t.tail };
}

// ---- Sections 1, 2 and 10: the command line, the output and the all-or-nothing write ----

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
    else if (kind === 'unified') edits = unified(lines, strict);
    else if (kind === 'search-replace') edits = searchReplace(lines, strict);
    else edits = v4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const kept = tree.moved.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moved.length = kept;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const state = new Map<string, string>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    state.set(p, was === null ? 'A' : now === null ? 'D' : 'M');
  }
  const rows: Array<{ at: string; line: string }> = [];
  const swept = new Set<string>();
  for (const [oldP, newP] of tree.moved) {
    if (state.get(oldP) === 'D' && state.get(newP) === 'A') {
      rows.push({ at: newP, line: `R ${oldP} -> ${newP}` });
      swept.add(oldP);
      swept.add(newP);
    }
  }
  for (const [p, k] of state) if (!swept.has(p)) rows.push({ at: p, line: `${k} ${p}` });
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.at), Buffer.from(b.at)));
  if (!check) {
    for (const [p, k] of state) {
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
