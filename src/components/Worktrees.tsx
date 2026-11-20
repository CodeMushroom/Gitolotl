import { useCallback, useEffect, useState } from "react";
import { pickFolder } from "../actions";
import { aiAgent } from "../ai";
import { api } from "../api";
import type { WorktreeDetail } from "../api";
import { fmtDate, st } from "../store";

/** Every worktree of the repository at a glance: who is working where, and in what state. */
export function Worktrees() {
  const repo = st().repo?.path ?? "";
  const [rows, setRows] = useState<WorktreeDetail[] | null>(null);
  const [err, setErr] = useState("");
  const [adding, setAdding] = useState(false);
  const [branch, setBranch] = useState("");
  const [create, setCreate] = useState(true);
  const [parent, setParent] = useState("");

  const load = useCallback(() => {
    api.worktreeDetails(repo).then(setRows).catch((e) => setErr(String(e)));
  }, [repo]);
  useEffect(load, [load]);

  const run = async (fn: () => Promise<unknown>) => {
    setErr("");
    try { await fn(); load(); void st().refresh(); } catch (e) { setErr(String(e)); }
  };
  const folder = branch.trim().replace(/[\\/:*?"<>|\s]+/g, "-");
  const add = () => run(async () => {
    if (!branch.trim() || !parent) throw new Error("Choose a branch name and a parent folder");
    await api.addWorktree(repo, `${parent.replace(/[\\/]+$/, "")}/${st().repo?.name}-${folder}`, branch.trim(), create);
    setAdding(false); setBranch("");
  });

  return (
    <div className="modal wide" onMouseDown={(e) => e.stopPropagation()}>
      <h3>Worktrees</h3>
      <p className="dim">Each worktree is a separate checkout of this repository, the usual way to let several agents work in parallel.</p>
      {err && <div className="form-err">{err}</div>}
      <div className="wt-list">
        {!rows && !err && <div className="hint">Loading…</div>}
        {rows?.map((w) => {
          const agent = w.last ? aiAgent(w.last) : null;
          return (
            <div key={w.path} className={`wt${w.current ? " current" : ""}`}>
              <div className="wt-main">
                <div className="wt-title">
                  <b>{w.branch ?? `detached ${w.head.slice(0, 7)}`}</b>
                  {w.current && <span className="pill">this window</span>}
                  {w.missing && <span className="pill warn">folder missing</span>}
                  {w.dirty > 0 && <span className="pill warn">{w.dirty} uncommitted</span>}
                  {w.ahead > 0 && <span className="pill">↑{w.ahead}</span>}
                  {w.behind > 0 && <span className="pill">↓{w.behind}</span>}
                  {!w.missing && !w.hasUpstream && w.branch && <span className="pill dimpill">not pushed</span>}
                </div>
                <div className="dim wt-path" title={w.path}>{w.path}</div>
                {w.last && (
                  <div className="wt-last">
                    {agent && <span className="aichip">✦ {agent}</span>}
                    <span className="subject">{w.last.subject}</span>
                    <span className="dim">{w.last.author} · {fmtDate(w.last.time)}</span>
                  </div>
                )}
              </div>
              {!w.current && !w.missing && <button className="btn" onClick={() => { st().set({ modal: null }); void st().openRepo(w.path); }}>Open</button>}
              {!w.current && <button className="btn danger" title="Git refuses if it has uncommitted or untracked files" onClick={() => run(() => api.removeWorktree(repo, w.path))}>Remove</button>}
            </div>
          );
        })}
      </div>
      {adding ? (
        <div className="wt-add">
          <label className="field"><span>Branch</span><input autoFocus value={branch} placeholder="agent/fix-login" spellCheck={false} onChange={(e) => setBranch(e.target.value)} /></label>
          <label className="check"><input type="checkbox" checked={create} onChange={(e) => setCreate(e.target.checked)} /> Create this branch (from the current commit)</label>
          <div className="folder">
            <input readOnly value={parent ? `${parent.replace(/[\\/]+$/, "")}/${st().repo?.name}-${folder || "…"}` : ""} placeholder="Choose where to put the new folder…" />
            <button className="btn" onClick={async () => { const p = await pickFolder(); if (p) setParent(p); }}>Browse…</button>
          </div>
        </div>
      ) : null}
      <div className="modal-btns">
        <button className="btn" onClick={() => st().set({ modal: null })}>Close</button>
        <button className="btn" onClick={load}>Refresh</button>
        {adding
          ? <button className="btn primary" onClick={() => void add()}>Create worktree</button>
          : <button className="btn primary" onClick={() => setAdding(true)}>New worktree…</button>}
      </div>
    </div>
  );
}
