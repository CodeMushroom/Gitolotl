import { memo, useEffect, useMemo, useRef, useState } from "react";
import { A } from "../actions";
import { api } from "../api";
import type { BlameLine, Commit } from "../api";
import { hunkPatch, linesPatch, parseDiff, patchStats, splitPatch } from "../diff";
import type { FileDiff, Hunk } from "../diff";
import { fileRisks } from "../risk";
import { fmtDate, st, useStore } from "../store";
import type { OpenFile } from "../store";
import { langOf, tokenize } from "../syntax";
import { MergeEditor } from "./MergeEditor";
import { quick } from "./Panel";

const MAX_LINES = 8000;

type Data =
  | { view: "diff"; diff: FileDiff; truncated: boolean }
  | { view: "all"; files: { path: string; diff: FileDiff }[]; truncated: boolean }
  | { view: "blame"; lines: BlameLine[] }
  | { view: "history"; commits: Commit[] };

const Code = memo(function Code({ text, lang }: { text: string; lang: string }) {
  if (!text) return <span className="code"> </span>;
  return (
    <span className="code">
      {tokenize(text, lang).map(([cls, t], i) => (cls ? <span key={i} className={`t-${cls}`}>{t}</span> : t))}
    </span>
  );
});

function DiffBody({ of, path, diff, truncated, embedded }: { of: OpenFile; path: string; diff: FileDiff; truncated: boolean; embedded?: boolean }) {
  const canEdit = (of.kind === "worktree" || of.kind === "staged") && !diff.combined && !diff.binary;
  const lang = langOf(path);
  // selected changed lines, per hunk, for line-level staging
  const [sel, setSel] = useState<Record<number, Set<number>>>({});
  const anchor = useRef<{ hunk: number; line: number } | null>(null);
  useEffect(() => { setSel({}); anchor.current = null; }, [diff]);

  const toggle = (hi: number, li: number, shift: boolean, h: Hunk) => {
    setSel((old) => {
      const set = new Set(old[hi] ?? []);
      const a = anchor.current;
      if (shift && a && a.hunk === hi) {
        for (let k = Math.min(a.line, li); k <= Math.max(a.line, li); k++) if (h.lines[k].type === "+" || h.lines[k].type === "-") set.add(k);
      } else if (set.has(li)) set.delete(li);
      else set.add(li);
      return { ...old, [hi]: set };
    });
    anchor.current = { hunk: hi, line: li };
  };

  const apply = (patch: string, cached: boolean, reverse: boolean) => quick((r) => api.applyPatch(r, patch, cached, reverse));
  const confirmDiscard = (what: string, patch: string) =>
    st().set({ modal: { kind: "form", title: `Discard ${what}?`, message: "A safety snapshot is saved first, so Ctrl+Z brings it back.", confirm: "Discard", danger: true, onSubmit: () => apply(patch, false, true) } });

  if (diff.binary) return <div className="empty">Binary file: no text diff available.</div>;
  if (diff.hunks.length === 0) return <div className="empty">No textual changes{diff.header.some((l) => l.startsWith("rename ")) ? " (file renamed)" : ""}.</div>;
  let budget = MAX_LINES;
  return (
    <div className={embedded ? "diff-embedded" : "diff"}>
      {diff.hunks.map((h, i) => {
        if (budget <= 0) return null;
        const lines = h.lines.slice(0, budget);
        budget -= lines.length;
        const picked = sel[i] ?? new Set<number>();
        const n = picked.size;
        const unit = n ? `${n} line${n === 1 ? "" : "s"}` : "hunk";
        return (
          <div className="hunk" key={i}>
            <div className="hunk-h">
              <span className="mono">{h.header}</span>
              <span className="grow" />
              {n > 0 && <button className="link" onClick={() => setSel((o) => ({ ...o, [i]: new Set() }))}>Clear selection</button>}
              {canEdit && of.kind === "worktree" && (
                <button className="link danger" onClick={() => confirmDiscard(n ? unit : "this hunk", n ? linesPatch(diff, h, picked, true) : hunkPatch(diff, h))}>Discard {unit}</button>
              )}
              {canEdit && of.kind === "worktree" && (
                <button className="link" onClick={() => void apply(n ? linesPatch(diff, h, picked, false) : hunkPatch(diff, h), true, false)}>Stage {unit}</button>
              )}
              {canEdit && of.kind === "staged" && (
                <button className="link" onClick={() => void apply(n ? linesPatch(diff, h, picked, true) : hunkPatch(diff, h), true, true)}>Unstage {unit}</button>
              )}
            </div>
            {lines.map((l, j) => {
              const changed = l.type === "+" || l.type === "-";
              const pickable = canEdit && changed;
              return (
                <div key={j} className={`dl ${l.type === "+" ? "add" : l.type === "-" ? "del" : l.type === "\\" ? "meta" : ""}${picked.has(j) ? " picked" : ""}`}>
                  <span
                    className={`gutter${pickable ? " pickable" : ""}`}
                    title={pickable ? "Click to select this line (Shift-click for a range), then stage just the selection" : undefined}
                    onClick={pickable ? (e) => toggle(i, j, e.shiftKey, h) : undefined}
                  >
                    <span className="ln">{l.oldNo ?? ""}</span>
                    <span className="ln">{l.newNo ?? ""}</span>
                    <span className="sign">{picked.has(j) ? "●" : changed ? l.type : ""}</span>
                  </span>
                  {l.type === "\\" ? <span className="code">{l.text}</span> : <Code text={l.text} lang={lang} />}
                </div>
              );
            })}
          </div>
        );
      })}
      {(truncated || budget <= 0) && <div className="empty">Diff is very large: output truncated.</div>}
    </div>
  );
}

function AllFiles({ of, files, truncated }: { of: OpenFile; files: { path: string; diff: FileDiff }[]; truncated: boolean }) {
  const shown = useMemo(() => files.slice(0, 300), [files]);
  const risks = useMemo(() => shown.map((f) => fileRisks(f.path, f.diff)), [shown]);
  const flagged = risks.filter((r) => r.length > 0).length;
  return (
    <div className="diff">
      {files.length === 0 && <div className="empty">No changes.</div>}
      {flagged > 0 && (
        <div className="risk-bar">
          <b>⚠ {flagged} of {shown.length} file{shown.length === 1 ? "" : "s"} deserve a closer look</b>
          <span className="dim">Pattern-based hints, checked locally.</span>
        </div>
      )}
      {shown.map((f, i) => {
        const s = patchStats(f.diff);
        return (
          <div key={f.path + i} className="allfile">
            <div className="allfile-h">
              <span className="path">{f.path}</span>
              <span className="st-add">+{s.add}</span>
              <span className="st-del">−{s.del}</span>
              {risks[i].map((r) => <span key={r.label} className="riskchip" title={r.why}>⚠ {r.label}</span>)}
            </div>
            <DiffBody of={of} path={f.path} diff={f.diff} truncated={false} embedded />
          </div>
        );
      })}
      {truncated && <div className="empty">Patch is very large: output truncated.</div>}
    </div>
  );
}

function BlameBody({ lines, path }: { lines: BlameLine[]; path: string }) {
  const lang = langOf(path);
  return (
    <div className="diff blame">
      {lines.map((l, i) => {
        const first = i === 0 || lines[i - 1].hash !== l.hash;
        const uncommitted = /^0+$/.test(l.hash);
        return (
          <div key={i} className={`dl${first ? " bfirst" : ""}`}>
            <span className="binfo" title={first ? `${l.summary}\n${l.author}` : undefined} onClick={() => !uncommitted && st().select({ type: "commit", hash: l.hash }, true)}>
              {first ? (uncommitted ? "Uncommitted" : `${l.hash.slice(0, 7)} ${l.author.slice(0, 14)} · ${fmtDate(l.time)}`) : ""}
            </span>
            <span className="ln">{l.line}</span>
            <Code text={l.text} lang={lang} />
          </div>
        );
      })}
    </div>
  );
}

export function DiffView() {
  const of = useStore((s) => s.openFile);
  const repo = useStore((s) => s.repo?.path);
  const conflicted = useStore((s) => !!s.openFile && !!s.status?.files.some((f) => f.kind === "conflict" && f.path === s.openFile?.path));
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!of || !repo || of.view === "merge") return;
    let live = true;
    setError("");
    const rev = of.kind === "commit" ? of.hash : undefined;
    const p: Promise<Data> =
      of.view === "blame" ? api.blame(repo, of.path, rev).then((lines) => ({ view: "blame", lines }))
      : of.view === "history" ? api.log(repo, 1000, false, of.path).then((commits) => ({ view: "history", commits }))
      : of.path === "*" ? api.patch(repo, of.kind === "untracked" ? "worktree" : of.kind, of.hash).then((d) => ({ view: "all", files: splitPatch(d.text), truncated: d.truncated }))
      : api.diff(repo, of.kind, of.path, of.hash, of.oldPath).then((d) => ({ view: "diff", diff: parseDiff(d.text), truncated: d.truncated }));
    p.then((d) => live && setData(d)).catch((e) => { if (live) { setData(null); setError(String(e)); } });
    return () => { live = false; };
  }, [of, repo]);

  if (!of) return null;
  const all = of.path === "*";
  const want = all ? "all" : of.view;
  const tab = (v: OpenFile["view"], label: string) => (
    <button className={`tabbtn${of.view === v ? " on" : ""}`} onClick={() => st().setOpenFile({ ...of, view: v })}>{label}</button>
  );
  return (
    <div className="diffview">
      <div className="diff-h">
        <span className="mono path" title={of.path}>{all ? "All changes" : `${of.oldPath ? `${of.oldPath} → ` : ""}${of.path}`}</span>
        <span className="tag">{of.kind === "commit" ? of.hash?.slice(0, 7) : of.kind}</span>
        <span className="grow" />
        {all && <button className="link" onClick={() => A.copyForAi(of.kind === "untracked" ? "worktree" : of.kind, of.hash)}>Copy diff for AI</button>}
        {!all && conflicted && tab("merge", "Merge")}
        {!all && tab("diff", "Diff")}
        {!all && of.kind !== "untracked" && tab("blame", "Blame")}
        {!all && of.kind !== "untracked" && tab("history", "History")}
        <button className="iconbtn" title="Close (Esc)" onClick={() => st().setOpenFile(null)}>✕</button>
      </div>
      {of.view === "merge" ? <MergeEditor path={of.path} /> : (
        <>
          {error && <div className="empty err">{error}</div>}
          {!error && (!data || data.view !== want) && <div className="empty">Loading…</div>}
          {!error && data?.view === "all" && all && <AllFiles of={of} files={data.files} truncated={data.truncated} />}
          {!error && !all && data?.view === "diff" && of.view === "diff" && <DiffBody of={of} path={of.path} diff={data.diff} truncated={data.truncated} />}
          {!error && data?.view === "blame" && of.view === "blame" && <BlameBody lines={data.lines} path={of.path} />}
          {!error && data?.view === "history" && of.view === "history" && (
            <div className="diff history">
              {data.commits.length === 0 && <div className="empty">No history for this file.</div>}
              {data.commits.map((c) => (
                <div key={c.hash} className="hrow" onClick={() => st().select({ type: "commit", hash: c.hash }, true)}>
                  <span className="mono dim">{c.hash.slice(0, 7)}</span>
                  <span className="subject">{c.subject}</span>
                  <span className="dim">{c.author}</span>
                  <span className="dim">{fmtDate(c.time)}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
