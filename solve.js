// solve.js — a fast drop-in for makefun-diff 1.0.0, written from scratch.
//
// The answer rule (competition.yaml): lines split after every "\n" only; a
// trailing line without "\n" is a line too; two lines are equal only when
// identical code units, newline included. Edit script: longest common prefix,
// then longest common suffix of the rest; between them Myers's greedy search
// that keeps, on each diagonal, the path furthest into the old text, takes the
// deletion when deletion and insertion reach the same point, never steps past
// either text's end, prunes no edge diagonal, and follows every run of equal
// lines as far as it goes; the first path to reach both ends is the script.
// Patch: "makefun-diff/1 old=N new=M hunks=H deleted=D inserted=I", then per
// hunk "@ os ol ns nl" and one line per covered line ("=" kept, "-" deleted,
// "+" inserted); change runs list deletions before insertions, show up to 3
// kept lines before/after, runs at most 6 kept lines apart share a hunk; a
// line ending its text without a newline is written with one and followed by
// a "%" line; identical texts are the header line alone.
//
// Speed design: lines are interned to integer ids once (one shared Map per
// case, so equality is an int compare), prefix/suffix are trimmed on the id
// arrays, and Myers runs on Int32Array V-rows (stored shifted by +1, so 0
// means "no path") with the exact tie-break above; the script is recovered
// by backtracking the stored rows, which reproduces the reference's chosen
// path step for step. No work is cached between cases.

const FORMAT = 'makefun-diff/1';
const CONTEXT = 3;
const KEEP = 0;
const DELETE = 1;
const INSERT = 2;

/** Split a text into lines; intern each line to a small integer id. */
function tokenize(text, map, next) {
  const parts = text.split('\n');
  const last = parts.length - 1;
  // The last part is a line only when non-empty (text does not end in "\n").
  const n = parts[last] === '' ? last : parts.length;
  const ids = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const part = parts[i];
    let base = map.get(part);
    if (base === undefined) {
      base = next.v;
      next.v += 2;
      map.set(part, base);
    }
    // Slot 0 of a part's pair = the line with "\n", slot 1 = without.
    ids[i] = base + (i < last ? 0 : 1);
  }
  return { parts, n, ids };
}

/**
 * The edit script of id-arrays a into b as runs [{kind, count}] in order,
 * kind 0 = keep, 1 = delete, 2 = insert. Exact Myers with the reference's
 * deletion-wins tie-break and no edge pruning.
 */
function editRuns(a, b) {
  const N = a.length;
  const M = b.length;
  // Depth 0: the opening snake from (0, 0).
  let x = 0;
  let y = 0;
  while (x < N && y < M && a[x] === b[y]) { x++; y++; }
  if (x >= N && y >= M) return x > 0 ? [{ kind: KEEP, count: x }] : [];
  // Vs[d] is the row of furthest x per diagonal k (index k + d), stored +1.
  const Vs = [new Int32Array(1)];
  Vs[0][0] = x + 1;
  let D = -1;
  let kF = 0;
  let xF = 0;
  outer: for (let d = 1; d <= N + M; d++) {
    const cur = new Int32Array(2 * d + 1);
    const prev = Vs[d - 1];
    const plen = prev.length;
    for (let k = -d, ki = 0; k <= d; k += 2, ki += 2) {
      // Deletion: from diagonal k-1, one old line further (needs an old line).
      let xDel = -1;
      const iDel = ki - 2;
      if (iDel >= 0) {
        const v = prev[iDel];
        if (v !== 0) {
          const xp = v - 1;
          if (xp < N) xDel = xp + 1;
        }
      }
      // Insertion: from diagonal k+1, one new line further (needs a new line).
      let xIns = -1;
      const iIns = ki;
      if (iIns < plen) {
        const v = prev[iIns];
        if (v !== 0) {
          const xp = v - 1;
          if (xp - (k + 1) < M) xIns = xp;
        }
      }
      if (xDel < 0 && xIns < 0) continue;
      // Furthest into the old text; deletion wins the tie.
      let xx = xDel >= xIns ? xDel : xIns;
      let yy = xx - k;
      while (xx < N && yy < M && a[xx] === b[yy]) { xx++; yy++; }
      cur[ki] = xx + 1;
      if (xx >= N && yy >= M) { D = d; kF = k; xF = xx; break outer; }
    }
    Vs.push(cur);
  }
  if (D < 0) throw new Error('diff: the search ended without reaching both ends');
  // Backtrack the stored rows from (D, kF) to (0, 0), collecting runs reversed.
  const revKind = [];
  const revCount = [];
  const pushRev = (kind, count) => {
    const L = revKind.length;
    if (L > 0 && revKind[L - 1] === kind) revCount[L - 1] += count;
    else { revKind.push(kind); revCount.push(count); }
  };
  x = xF;
  y = xF - kF;
  for (let d = D; d >= 1; d--) {
    const prev = Vs[d - 1];
    const plen = prev.length;
    const k = x - y;
    let xDel = -1;
    let xIns = -1;
    const iDel = k + d - 2;
    if (iDel >= 0 && iDel < plen) {
      const v = prev[iDel];
      if (v !== 0) {
        const xp = v - 1;
        if (xp < N) xDel = xp + 1;
      }
    }
    const iIns = k + d;
    if (iIns >= 0 && iIns < plen) {
      const v = prev[iIns];
      if (v !== 0) {
        const xp = v - 1;
        if (xp - (k + 1) < M) xIns = xp;
      }
    }
    const isDel = xDel >= xIns;
    const xPre = isDel ? xDel : xIns;
    const yPre = xPre - k;
    const snake = x - xPre;
    if (snake > 0) pushRev(KEEP, snake);
    pushRev(isDel ? DELETE : INSERT, 1);
    x = xPre - (isDel ? 1 : 0);
    y = yPre - (isDel ? 0 : 1);
  }
  if (x > 0) pushRev(KEEP, x);
  const runs = [];
  for (let i = revKind.length - 1; i >= 0; i--) runs.push({ kind: revKind[i], count: revCount[i] });
  return runs;
}

/** A line as the patch writes it: op, the line, a newline, "%" when it had none. */
function written(op, parts, i) {
  const line = parts[i];
  return i < parts.length - 1 ? op + line + '\n' : op + line + '\n%\n';
}

/** makefun-diff 1.0.0's answer for one case's input { old, new }. */
export function run(input) {
  if (input === null || typeof input !== 'object' || typeof input.old !== 'string' || typeof input.new !== 'string') {
    throw new TypeError('diff: the input is { old, new }, two strings');
  }
  const map = new Map();
  const next = { v: 0 };
  const a = tokenize(input.old, map, next);
  const b = tokenize(input.new, map, next);
  const n = a.n;
  const m = b.n;
  // The common prefix, then the common suffix of what is left.
  let prefix = 0;
  while (prefix < n && prefix < m && a.ids[prefix] === b.ids[prefix]) prefix++;
  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix && a.ids[n - 1 - suffix] === b.ids[m - 1 - suffix]) suffix++;
  const runs = [];
  const pushRun = (kind, count) => {
    if (count <= 0) return;
    const L = runs.length;
    if (L > 0 && runs[L - 1].kind === kind) runs[L - 1].count += count;
    else runs.push({ kind, count });
  };
  pushRun(KEEP, prefix);
  for (const r of editRuns(a.ids.subarray(prefix, n - suffix), b.ids.subarray(prefix, m - suffix))) pushRun(r.kind, r.count);
  pushRun(KEEP, suffix);

  // The change runs: each a stretch of deletions and insertions between two
  // kept lines, at old line o and new line p.
  const changes = [];
  let o = 0;
  let p = 0;
  let deleted = 0;
  let inserted = 0;
  for (const r of runs) {
    if (r.kind === KEEP) { o += r.count; p += r.count; continue; }
    let c = changes.length > 0 ? changes[changes.length - 1] : undefined;
    if (c === undefined || c.o + c.dels !== o || c.p + c.ins !== p) {
      c = { o, p, dels: 0, ins: 0 };
      changes.push(c);
    }
    if (r.kind === DELETE) { c.dels += r.count; o += r.count; deleted += r.count; }
    else { c.ins += r.count; p += r.count; inserted += r.count; }
  }

  // The hunks: change runs at most 2 * CONTEXT kept lines apart share one.
  const hunks = [];
  for (const c of changes) {
    const h = hunks.length > 0 ? hunks[hunks.length - 1] : undefined;
    const prev = h !== undefined ? h[h.length - 1] : undefined;
    if (prev !== undefined && c.o - (prev.o + prev.dels) <= 2 * CONTEXT) h.push(c);
    else hunks.push([c]);
  }

  const out = [`${FORMAT} old=${n} new=${m} hunks=${hunks.length} deleted=${deleted} inserted=${inserted}\n`];
  for (const h of hunks) {
    const first = h[0];
    const last = h[h.length - 1];
    const oldStart = Math.max(0, first.o - CONTEXT);
    const newStart = first.p - (first.o - oldStart);
    const after = Math.min(CONTEXT, n - (last.o + last.dels));
    const oldEnd = last.o + last.dels + after;
    const newEnd = last.p + last.ins + after;
    out.push(`@ ${oldStart + 1} ${oldEnd - oldStart} ${newStart + 1} ${newEnd - newStart}\n`);
    let at = oldStart;
    for (const c of h) {
      for (; at < c.o; at++) out.push(written('=', a.parts, at));
      for (let i = 0; i < c.dels; i++) out.push(written('-', a.parts, c.o + i));
      for (let i = 0; i < c.ins; i++) out.push(written('+', b.parts, c.p + i));
      at = c.o + c.dels;
    }
    for (; at < oldEnd; at++) out.push(written('=', a.parts, at));
  }
  return out.join('');
}
