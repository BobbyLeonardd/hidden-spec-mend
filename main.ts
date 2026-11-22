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

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === MARK + 'Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === FIND_OPEN)) return 'search-replace';
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

/* Sections 3 and 5: a file's text, and its lines matched at three levels. */

/** The prefix every V4A marker line carries. */
const MARK = '*** ';

/** A file as section 3 reads it: its cells, its break and whether it ends with one. */
interface TextFile {
  cells: string[];
  brk: string;
  tail: boolean;
}

function asText(text: string): TextFile {
  if (text === '') return { cells: [], brk: '\n', tail: false };
  const cut = text.indexOf('\n');
  const brk = cut > 0 && text[cut - 1] === '\r' ? '\r\n' : '\n';
  const cells = text.split(brk);
  const tail = text.endsWith(brk);
  if (tail) cells.pop();
  return { cells, brk, tail };
}

/** A file of no cells is written empty. */
const asBytes = (f: TextFile): string => (f.cells.length === 0 ? '' : f.cells.join(f.brk) + (f.tail ? f.brk : ''));

/** One row of a patch body: context, old, new or a `\` marker; `gap` marks a blank patch line. */
interface PatchRow {
  kind: string;
  text: string;
  gap?: boolean;
}

const indentOf = (s: string): string => /^[ \t]*/.exec(s)![0];

function equalAt(a: string, b: string, level: number): boolean {
  if (level === 0) return a === b;
  if (level === 1) return a.replace(/[ \t]+$/, '') === b.replace(/[ \t]+$/, '');
  return a.replace(/^[ \t]+|[ \t]+$/g, '') === b.replace(/^[ \t]+|[ \t]+$/g, '');
}

function matchesAt(cells: string[], spot: number, old: string[], level: number): boolean {
  if (spot < 0 || spot + old.length > cells.length) return false;
  for (let j = 0; j < old.length; j++) if (!equalAt(cells[spot + j]!, old[j]!, level)) return false;
  return true;
}

function spots(cells: string[], old: string[], level: number): number[] {
  const out: number[] = [];
  for (let i = 0; i + old.length <= cells.length; i++) if (matchesAt(cells, i, old, level)) out.push(i);
  return out;
}

const topLevel = (strict: boolean): number => (strict ? 0 : 2);

/** The first level the old side occurs at, with every hit there. */
function levelHit(cells: string[], old: string[], strict: boolean): { level: number; at: number[] } | null {
  for (let level = 0; level <= topLevel(strict); level++) {
    const at = spots(cells, old, level);
    if (at.length > 0) return { level, at };
  }
  return null;
}

const leftSide = (piece: PatchRow[]): string[] => piece.filter((x) => x.kind === ' ' || x.kind === '-').map((x) => x.text);

const rightCount = (piece: PatchRow[]): number => piece.filter((x) => x.kind === ' ' || x.kind === '+').length;

/** A row of the new side at level 2: its own indentation swapped for the file's. */
function alignTo(row: string, from: string, to: string): string {
  if (row === '' || /^[ \t]+$/.test(row)) return row;
  if (!row.startsWith(from)) return row;
  return to + row.slice(from.length);
}

/** Replace k cells at `spot` with the new side: context from the file, the rest re-indented at level 2. */
function swapRun(cells: string[], spot: number, k: number, piece: PatchRow[], level: number): string[] {
  const out = cells.slice(0, spot);
  const head = piece.find((x) => x.kind === ' ' || x.kind === '-');
  const from = head === undefined ? '' : indentOf(head.text);
  const to = indentOf(cells[spot] ?? '');
  let oi = spot;
  for (const x of piece) {
    if (x.kind === ' ') out.push(cells[oi++]!);
    else if (x.kind === '-') oi += 1;
    else if (x.kind === '+') out.push(level === 2 ? alignTo(x.text, from, to) : x.text);
  }
  out.push(...cells.slice(spot + k));
  return out;
}

/** True when a `\` row follows the hunk's last context or `+` row. */
function noNewlineAfter(piece: PatchRow[]): boolean {
  let last = -1;
  for (let i = 0; i < piece.length; i++) if (piece[i]!.kind === ' ' || piece[i]!.kind === '+') last = i;
  return last >= 0 && piece.slice(last + 1).some((x) => x.kind === '\\');
}

/** True when a `\` row follows a created file's last `+` row. */
function createdOpenEnded(pieces: PatchRow[][]): boolean {
  for (let h = pieces.length - 1; h >= 0; h--) {
    const piece = pieces[h]!;
    let last = -1;
    for (let i = 0; i < piece.length; i++) if (piece[i]!.kind === '+') last = i;
    if (last >= 0) return piece.slice(last + 1).some((x) => x.kind === '\\');
  }
  return false;
}

/** The rows after a `@@` header, up to a section start or a row that is no body row. */
function partFrom(lines: string[], at: number): { piece: PatchRow[]; next: number } {
  const piece: PatchRow[] = [];
  let i = at;
  while (i < lines.length) {
    const row = lines[i]!;
    if (row.startsWith('diff --git ') || (row.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '))) break;
    if (!(row === '' || row[0] === ' ' || row[0] === '-' || row[0] === '+' || row[0] === '\\')) break;
    piece.push(row === '' ? { kind: ' ', text: '', gap: true } : { kind: row[0]!, text: row.slice(1) });
    i += 1;
  }
  while (piece.length > 0 && piece[piece.length - 1]!.kind === ' ' && piece[piece.length - 1]!.text === '') piece.pop();
  return { piece, next: i };
}

/* Section 6: unified diffs. */

interface HunkRange {
  a: number;
  piece: PatchRow[];
}

interface DiffSection {
  oldPath?: string | null;
  newPath?: string | null;
  fromRename?: string;
  toRename?: string;
  fromDiff?: string;
  toDiff?: string;
  fresh: boolean;
  gone: boolean;
  hunks: HunkRange[];
}

const DIFF_LINE = /^diff --git a\/(.+) b\/(.+)$/;
const HUNK_LINE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

const dropSide = (p: string): string => (p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p);

/** A `--- `/`+++ ` path: up to the first tab, spaces trimmed; `/dev/null` is no file. */
function pathOfHeader(rest: string): string | null {
  const p = rest.split('\t')[0]!.trim();
  return p === '/dev/null' ? null : dropSide(p);
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const secs: DiffSection[] = [];
  let cur: DiffSection | null = null;
  let i = 0;
  while (i < lines.length) {
    const row = lines[i]!;
    if (row.startsWith('diff --git ')) {
      const m = DIFF_LINE.exec(row);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = { fromDiff: m[1]!, toDiff: m[2]!, fresh: false, gone: false, hunks: [] };
      secs.push(cur);
      i += 1;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (row.startsWith('--- ')) {
        if (!(lines[i + 1] ?? '').startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        if (cur.oldPath !== undefined || cur.newPath !== undefined) {
          cur = { fresh: false, gone: false, hunks: [] };
          secs.push(cur);
        }
        cur.oldPath = pathOfHeader(row.slice(4));
        cur.newPath = pathOfHeader(lines[i + 1]!.slice(4));
        i += 2;
        continue;
      }
      if (row.startsWith('rename from ')) {
        cur.fromRename = row.slice(12).trim();
        i += 1;
        continue;
      }
      if (row.startsWith('rename to ')) {
        cur.toRename = row.slice(10).trim();
        i += 1;
        continue;
      }
      if (row.startsWith('new file mode')) {
        cur.fresh = true;
        i += 1;
        continue;
      }
      if (row.startsWith('deleted file mode')) {
        cur.gone = true;
        i += 1;
        continue;
      }
    }
    if (row.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_LINE.exec(row);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const read = partFrom(lines, i + 1);
      cur.hunks.push({ a: Number(m[1]), piece: read.piece });
      i = read.next;
      continue;
    }
    if (row.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      cur = { fresh: false, gone: false, hunks: [] };
      secs.push(cur);
      cur.oldPath = pathOfHeader(row.slice(4));
      cur.newPath = pathOfHeader(lines[i + 1]!.slice(4));
      i += 2;
      continue;
    }
    i += 1;
  }
  const edits: Edit[] = [];
  for (const s of secs) {
    const from = s.oldPath !== undefined ? s.oldPath : s.fromRename !== undefined ? s.fromRename : s.fromDiff;
    const to = s.newPath !== undefined ? s.newPath : s.toRename !== undefined ? s.toRename : s.toDiff;
    if (s.fresh || from === null) {
      if (to === null || to === undefined) continue;
      const target = to;
      const pieces = s.hunks.map((h) => h.piece);
      edits.push((tree) => {
        if (!safe(target)) throw new Fail('unsafe', target);
        if (tree.get(target) !== null) throw new Fail('exists', target);
        const made = pieces.flatMap((piece) => piece.filter((x) => x.kind === '+').map((x) => x.text));
        tree.now.set(target, asBytes({ cells: made, brk: '\n', tail: !createdOpenEnded(pieces) }));
      });
      continue;
    }
    if (s.gone || to === null) {
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
      const text = asBytes(applySection(asText(was), hunks, strict, target));
      if (dest !== null) {
        tree.now.set(dest, text);
        tree.now.set(target, null);
        tree.moved.push([target, dest]);
      } else tree.now.set(target, text);
    });
  }
  return edits;
}

/** A section's hunks, in order, each to the result of the ones before it. */
function applySection(text: TextFile, hunks: HunkRange[], strict: boolean, path: string): TextFile {
  let cells = text.cells;
  let tail = text.tail;
  let shift = 0;
  for (const h of hunks) {
    const old = leftSide(h.piece);
    const want = h.a - 1 + shift;
    let spot: number;
    let level = 0;
    if (old.length === 0) {
      spot = Math.max(0, Math.min(h.a + shift, cells.length));
    } else {
      const found = levelHit(cells, old, strict);
      if (found === null) throw new Fail('no-match', path);
      level = found.level;
      spot = found.at[0]!;
      for (const p of found.at) {
        const away = Math.abs(p - want);
        const best = Math.abs(spot - want);
        if (away < best || (away === best && p < spot)) spot = p;
      }
    }
    if (spot + old.length === cells.length) tail = !noNewlineAfter(h.piece);
    cells = swapRun(cells, spot, old.length, h.piece, level);
    shift += rightCount(h.piece) - old.length;
  }
  return { cells, brk: text.brk, tail };
}

/* Section 7: SEARCH/REPLACE blocks. */

const FIND_OPEN = '<<<<<<< SEARCH';
const FIND_MID = '=======';
const FIND_END = '>>>>>>> REPLACE';

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  let lastPath: string | null = null;
  let floor = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== FIND_OPEN) {
      i += 1;
      continue;
    }
    const open = i;
    let path: string | null = null;
    for (let j = open - 1; j >= floor; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = lastPath;
    if (path === null) throw new Exit2(`error: parse ${open + 1}`);
    let mid = -1;
    for (let j = open + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === FIND_MID) {
        mid = j;
        break;
      }
      if (t === FIND_END) break;
    }
    if (mid < 0) throw new Exit2(`error: parse ${open + 1}`);
    let end = -1;
    for (let j = mid + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === FIND_END) {
        end = j;
        break;
      }
    }
    if (end < 0) throw new Exit2(`error: parse ${open + 1}`);
    const olds = lines.slice(open + 1, mid);
    const news = lines.slice(mid + 1, end);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (olds.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, asBytes({ cells: news, brk: '\n', tail: true }));
        return;
      }
      const was = tree.get(p);
      if (was === null) throw new Fail('missing', p);
      const text = asText(was);
      const found = levelHit(text.cells, olds, strict);
      if (found === null) throw new Fail('no-match', p);
      if (found.at.length > 1) throw new Fail('ambiguous', p);
      const piece: PatchRow[] = [...olds.map((t) => ({ kind: '-', text: t })), ...news.map((t) => ({ kind: '+', text: t }))];
      tree.now.set(p, asBytes({ cells: swapRun(text.cells, found.at[0]!, olds.length, piece, found.level), brk: text.brk, tail: text.tail }));
    });
    lastPath = path;
    floor = end + 1;
    i = end + 1;
  }
  return edits;
}

/* Section 8: V4A patches. */

interface V4Hunk {
  anchor: string | null;
  eof: boolean;
  piece: PatchRow[];
}

interface V4Block {
  kind: string;
  path: string;
  dest: string | null;
  cells: string[];
  hunks: V4Hunk[];
}

/** A chunk's rows: context, old, new, blank; an end-of-file line ends it and anchors it to the end. */
function chunkAt(lines: string[], at: number, last: number): { piece: PatchRow[]; eof: boolean; next: number } {
  const piece: PatchRow[] = [];
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
    if (!(row === '' || row[0] === ' ' || row[0] === '-' || row[0] === '+')) break;
    piece.push(row === '' ? { kind: ' ', text: '', gap: true } : { kind: row[0]!, text: row.slice(1) });
    i += 1;
  }
  return { piece, eof, next: i };
}

function parseV4A(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== MARK + 'Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last > first && blank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== MARK + 'End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const secs: V4Block[] = [];
  let i = first + 1;
  while (i < last) {
    const row = lines[i]!;
    if (blank(row)) {
      i += 1;
      continue;
    }
    if (row.startsWith(MARK + 'Add File: ')) {
      const path = row.slice((MARK + 'Add File: ').length).trim();
      const kept: Array<{ t: string; gap: boolean }> = [];
      i += 1;
      while (i < last) {
        const b = lines[i]!;
        if (b.startsWith(MARK)) break;
        if (b === '') {
          kept.push({ t: '', gap: true });
          i += 1;
          continue;
        }
        if (b[0] !== '+') throw new Exit2(`error: parse ${i + 1}`);
        kept.push({ t: b.slice(1), gap: false });
        i += 1;
      }
      while (kept.length > 0 && kept[kept.length - 1]!.gap) kept.pop();
      secs.push({ kind: 'add', path, dest: null, cells: kept.map((x) => x.t), hunks: [] });
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
      secs.push({ kind: 'delete', path, dest: null, cells: [], hunks: [] });
      continue;
    }
    if (row.startsWith(MARK + 'Update File: ')) {
      const path = row.slice((MARK + 'Update File: ').length).trim();
      const start = i;
      i += 1;
      let dest: string | null = null;
      if (i < last && lines[i]!.startsWith(MARK + 'Move to: ')) {
        dest = lines[i]!.slice((MARK + 'Move to: ').length).trim();
        i += 1;
      }
      const hunks: V4Hunk[] = [];
      while (i < last) {
        const b = lines[i]!;
        if (b.startsWith(MARK)) break;
        if (b.startsWith('@@')) {
          const anchor = b.slice(2).trim();
          const read = chunkAt(lines, i + 1, last);
          hunks.push({ anchor: anchor === '' ? null : anchor, eof: read.eof, piece: read.piece });
          i = read.next;
          continue;
        }
        if (b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+') {
          if (b === '') {
            let j = i;
            while (j < last && blank(lines[j]!)) j += 1;
            if (j >= last || lines[j]!.startsWith(MARK)) {
              i = j;
              break;
            }
          }
          const read = chunkAt(lines, i, last);
          hunks.push({ anchor: null, eof: read.eof, piece: read.piece });
          i = read.next;
          continue;
        }
        break;
      }
      const tailHunk = hunks.length > 0 ? hunks[hunks.length - 1]! : null;
      while (tailHunk !== null && tailHunk.piece.length > 0 && tailHunk.piece[tailHunk.piece.length - 1]!.kind === ' ' && tailHunk.piece[tailHunk.piece.length - 1]!.text === '') {
        tailHunk.piece.pop();
      }
      if (hunks.length === 0 && dest === null) throw new Exit2(`error: parse ${start + 1}`);
      secs.push({ kind: 'update', path, dest, cells: [], hunks });
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  const edits: Edit[] = [];
  for (const s of secs) {
    if (s.kind === 'add') {
      const p = s.path;
      const made = s.cells;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, asBytes({ cells: made, brk: '\n', tail: true }));
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
    const dest = s.dest;
    const hunks = s.hunks;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (dest !== null && !safe(dest)) throw new Fail('unsafe', dest);
      const was = tree.get(p);
      if (was === null) throw new Fail('missing', p);
      if (dest !== null && tree.get(dest) !== null) throw new Fail('exists', dest);
      const text = asBytes(applyUpdate(asText(was), hunks, strict, p));
      if (dest !== null) {
        tree.now.set(dest, text);
        tree.now.set(p, null);
        tree.moved.push([p, dest]);
      } else tree.now.set(p, text);
    });
  }
  return edits;
}

/** A V4A Update File's chunks, with a cursor that starts at cell 0. */
function applyUpdate(text: TextFile, hunks: V4Hunk[], strict: boolean, path: string): TextFile {
  let cells = text.cells;
  let cursor = 0;
  for (const c of hunks) {
    if (c.anchor !== null) {
      let found = -1;
      for (let level = 0; level <= topLevel(strict) && found < 0; level++) {
        for (let i = cursor; i < cells.length; i++) {
          if (equalAt(cells[i]!, c.anchor, level)) {
            found = i;
            break;
          }
        }
      }
      if (found < 0) throw new Fail('no-match', path);
      cursor = found + 1;
    }
    const old = leftSide(c.piece);
    let spot: number;
    let level = 0;
    if (old.length === 0) {
      spot = c.eof ? cells.length : cursor;
    } else {
      let found = -1;
      for (let lv = 0; lv <= topLevel(strict) && found < 0; lv++) {
        for (let i = cursor; i + old.length <= cells.length; i++) {
          if (c.eof && i + old.length !== cells.length) continue;
          if (matchesAt(cells, i, old, lv)) {
            found = i;
            level = lv;
            break;
          }
        }
      }
      if (found < 0) throw new Fail('no-match', path);
      spot = found;
    }
    cells = swapRun(cells, spot, old.length, c.piece, level);
    cursor = spot + rightCount(c.piece);
  }
  return { cells, brk: text.brk, tail: text.tail };
}

/* Sections 1, 2 and 10: the command line, the output and the all-or-nothing write. */

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
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4A(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movedBefore = tree.moved.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moved.length = movedBefore;
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
  const listed: Array<{ at: string; line: string }> = [];
  const swept = new Set<string>();
  for (const [oldP, newP] of tree.moved) {
    if (state.get(oldP) === 'D' && state.get(newP) === 'A') {
      listed.push({ at: newP, line: `R ${oldP} -> ${newP}` });
      swept.add(oldP);
      swept.add(newP);
    }
  }
  for (const [p, k] of state) if (!swept.has(p)) listed.push({ at: p, line: `${k} ${p}` });
  listed.sort((a, b) => Buffer.compare(Buffer.from(a.at), Buffer.from(b.at)));
  if (!check) {
    for (const [p, k] of state) {
      if (k === 'D') rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, tree.now.get(p)!);
      }
    }
  }
  return { code: 0, out: [...listed.map((x) => x.line), `ok: ${listed.length} ${listed.length === 1 ? 'file' : 'files'}`] };
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
