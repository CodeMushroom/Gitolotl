export interface DiffLine { type: "+" | "-" | " " | "\\"; text: string; oldNo: number | null; newNo: number | null; raw: string }
export interface Hunk { header: string; lines: DiffLine[] }
export interface FileDiff { header: string[]; hunks: Hunk[]; binary: boolean; combined: boolean }

/**
 * Parses a single-file unified diff. Lines are split on "\n" only, so CRLF
 * content round-trips byte-for-byte when a hunk is re-assembled into a patch.
 */
export function parseDiff(text: string): FileDiff {
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const d: FileDiff = { header: [], hunks: [], binary: false, combined: false };
  let hunk: Hunk | null = null;
  let o = 0;
  let n = 0;
  for (const raw of lines) {
    if (raw.startsWith("@@@")) d.combined = true;
    if (raw.startsWith("@@")) {
      const m = /^@@+ -(\d+)(?:,\d+)? (?:-\d+(?:,\d+)? )*\+(\d+)/.exec(raw);
      o = m ? +m[1] : 0;
      n = m ? +m[2] : 0;
      hunk = { header: raw, lines: [] };
      d.hunks.push(hunk);
    } else if (!hunk) {
      if (raw.startsWith("Binary files") || raw.startsWith("GIT binary patch")) d.binary = true;
      d.header.push(raw);
    } else {
      const t = raw[0];
      const text = raw.slice(1).replace(/\r$/, "");
      if (t === "+") hunk.lines.push({ type: "+", text, oldNo: null, newNo: n++, raw });
      else if (t === "-") hunk.lines.push({ type: "-", text, oldNo: o++, newNo: null, raw });
      else if (t === "\\") hunk.lines.push({ type: "\\", text: raw, oldNo: null, newNo: null, raw });
      else hunk.lines.push({ type: " ", text, oldNo: o++, newNo: n++, raw });
    }
  }
  return d;
}

/** Builds a standalone patch containing just one hunk, suitable for `git apply`. */
export function hunkPatch(d: FileDiff, h: Hunk): string {
  return [...d.header, h.header, ...h.lines.map((l) => l.raw)].join("\n") + "\n";
}

/** Splits a multi-file patch into one chunk per file. */
export function splitPatch(text: string): { path: string; diff: FileDiff }[] {
  const parts = text.split(/^(?=diff --git )/m).filter((p) => p.startsWith("diff --git "));
  return parts.map((p) => {
    const diff = parseDiff(p);
    const plus = diff.header.find((l) => l.startsWith("+++ b/"))?.slice(6);
    const minus = diff.header.find((l) => l.startsWith("--- a/"))?.slice(6);
    const m = /^diff --git a\/.* b\/(.*)$/.exec(diff.header[0] ?? "");
    return { path: plus ?? minus ?? m?.[1] ?? "(unknown)", diff };
  });
}

export function patchStats(d: FileDiff): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const h of d.hunks) for (const l of h.lines) { if (l.type === "+") add++; else if (l.type === "-") del++; }
  return { add, del };
}

/**
 * Builds a patch containing only the selected changed lines of a hunk.
 *
 * `reverse = false`: the patch is applied forwards (staging). Unselected
 * additions are left out; unselected removals stay as context.
 * `reverse = true`: the patch is applied with --reverse (unstaging or
 * discarding). Unselected additions stay as context; unselected removals are
 * left out.
 */
export function linesPatch(d: FileDiff, h: Hunk, selected: Set<number>, reverse: boolean): string {
  const body: string[] = [];
  let oldCount = 0;
  let newCount = 0;
  let keptPrev = true;
  h.lines.forEach((l, i) => {
    if (l.type === "\\") {
      if (keptPrev) body.push(l.raw);
      return;
    }
    let type = l.type;
    let raw = l.raw;
    if (type !== " " && !selected.has(i)) {
      const becomesContext = reverse ? type === "+" : type === "-";
      if (!becomesContext) { keptPrev = false; return; }
      type = " ";
      raw = " " + l.raw.slice(1);
    }
    keptPrev = true;
    body.push(raw);
    if (type !== "+") oldCount++;
    if (type !== "-") newCount++;
  });
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(h.header);
  const header = `@@ -${m ? m[1] : 1},${oldCount} +${m ? m[2] : 1},${newCount} @@`;
  return [...d.header, header, ...body].join("\n") + "\n";
}
