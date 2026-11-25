import { useEffect, useState } from "react";
import { A, fileMenu } from "../actions";
import { aiAgent } from "../ai";
import { api } from "../api";
import type { ChangedFile, FileStatus } from "../api";
import { fullDate, st, useStore } from "../store";
import { Avatar } from "./Icon";

const STATUS_LABEL: Record<string, string> = { M: "Modified", A: "Added", D: "Deleted", R: "Renamed", C: "Copied", T: "Type changed", U: "Conflict", "?": "Untracked" };

function Badge({ code }: { code: string }) {
  return <span className={`badge s-${code === "?" ? "N" : code}`} title={STATUS_LABEL[code] ?? code}>{code === "?" ? "+" : code}</span>;
}

function FileName({ path }: { path: string }) {
  const i = path.lastIndexOf("/");
  return (
    <span className="fname" title={path}>
      {"‎"}
      {i !== -1 && <span className="fdir">{path.slice(0, i + 1)}</span>}
      {path.slice(i + 1)}
    </span>
  );
}

/** Unsent commit message drafts, kept per repository for the lifetime of the window. */
const drafts = new Map<string, string>();

/** Runs a quick index operation and refreshes only the status (keeps staging snappy). */
export async function quick(fn: (repo: string) => Promise<unknown>) {
  const repo = st().repo?.path;
  if (!repo) return;
  try { await fn(repo); } catch (e) { st().toast("err", String(e)); }
  await st().refreshStatus();
  const of = st().openFile;
  if (of && of.view === "diff") st().setOpenFile({ ...of }); // re-fetch the open diff
}

function WipPanel() {
  const status = useStore((s) => s.status);
  const openFile = useStore((s) => s.openFile);
  const busy = useStore((s) => s.busy);
  const repoPath = useStore((s) => s.repo?.path ?? "");
  const [msg, setMsgState] = useState(() => drafts.get(repoPath) ?? "");
  const setMsg = (m: string) => { drafts.set(repoPath, m); setMsgState(m); };
  const [amend, setAmend] = useState(false);
  const [signoff, setSignoff] = useState(false);
  if (!status) return null;

  const staged = status.files.filter((f) => f.kind === "tracked" && f.x !== ".");
  const unstaged = status.files.filter((f) => f.kind !== "tracked" || f.y !== ".");
  const conflicts = status.files.filter((f) => f.kind === "conflict").length;

  const toggleAmend = async (on: boolean) => {
    setAmend(on);
    if (on && !msg.trim() && st().repo) setMsg(await api.lastMessage(st().repo!.path).catch(() => ""));
  };
  const doCommit = async () => {
    if (!msg.trim() || busy) return;
    const ok = await st().act(amend ? "Amend commit" : "Commit", (r) => api.commit(r, msg, amend, signoff), true);
    if (ok) { setMsg(""); setAmend(false); st().toast("ok", amend ? "Commit amended" : "Committed"); }
  };

  const list = (files: FileStatus[], isStaged: boolean) =>
    files.map((f) => {
      const kind = isStaged ? "staged" : f.kind === "untracked" ? "untracked" : "worktree";
      const active = openFile?.path === f.path && openFile.kind === kind;
      return (
        <div
          key={f.path}
          className={`file${active ? " active" : ""}`}
          onClick={() => st().setOpenFile({ kind, path: f.path, view: f.kind === "conflict" ? "merge" : "diff" })}
          onContextMenu={(e) => fileMenu(e, f, isStaged)}
        >
          <Badge code={f.kind === "conflict" ? "U" : isStaged ? f.x : f.y} />
          <FileName path={f.path} />
          <button
            className="mini"
            title={isStaged ? "Unstage" : "Stage"}
            onClick={(e) => { e.stopPropagation(); void quick((r) => (isStaged ? api.unstage(r, [f.path]) : api.stage(r, [f.path]))); }}
          >
            {isStaged ? "−" : "+"}
          </button>
        </div>
      );
    });

  return (
    <div className="panel">
      {status.state && (
        <div className="opbar">
          <b>{status.state} in progress</b>
          <span>{conflicts ? `${conflicts} conflicted file${conflicts === 1 ? "" : "s"} — resolve, then stage them.` : "All conflicts resolved."}</span>
          <div className="oprow">
            {status.state !== "bisect" && <button className="btn primary" disabled={conflicts > 0} onClick={() => st().act(`Continue ${status.state}`, (r) => api.opContinue(r, status.state))}>Continue</button>}
            {status.state === "rebase" && <button className="btn" onClick={() => st().act("Skip commit", (r) => api.opSkip(r))}>Skip</button>}
            <button className="btn danger" onClick={() => st().act(`Abort ${status.state}`, (r) => api.opAbort(r, status.state))}>Abort</button>
          </div>
        </div>
      )}
      <div className="wip-head" title="Uncommitted changes in your working folder">
        <span className="dim">Your changes on</span>
        <b>{status.branch ?? `${status.head.slice(0, 7)} (detached)`}</b>
      </div>
      <div className="section-h">
        <span>Unstaged files ({unstaged.length})</span>
        <span className="grow" />
        {unstaged.length > 0 && <button className="link" title="Review every unstaged change in one scroll" onClick={() => A.reviewAll("worktree")}>Review</button>}
        {unstaged.length > 0 && <button className="link danger" onClick={() => A.discard(unstaged)}>Discard all</button>}
        {unstaged.length > 0 && <button className="link" onClick={() => quick((r) => api.stageAll(r))}>Stage all</button>}
      </div>
      <div className="files">{list(unstaged, false)}{unstaged.length === 0 && <div className="hint">Working tree clean</div>}</div>
      <div className="section-h">
        <span>Staged files ({staged.length})</span>
        <span className="grow" />
        {staged.length > 0 && <button className="link" title="Copy the staged diff, e.g. to ask an AI for a commit message or a review" onClick={() => A.copyForAi("staged")}>Copy for AI</button>}
        {staged.length > 0 && <button className="link" onClick={() => A.reviewAll("staged")}>Review</button>}
        {staged.length > 0 && <button className="link" onClick={() => quick((r) => api.unstageAll(r))}>Unstage all</button>}
      </div>
      <div className="files">{list(staged, true)}{staged.length === 0 && <div className="hint">Nothing staged</div>}</div>
      <div className="commitbox">
        <textarea
          placeholder={"Summary\n\nDescription (Ctrl+Enter to commit)"}
          value={msg}
          spellCheck
          onChange={(e) => setMsg(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void doCommit(); }}
        />
        <div className="commit-opts">
          <label><input type="checkbox" checked={amend} onChange={(e) => void toggleAmend(e.target.checked)} /> Amend</label>
          <label><input type="checkbox" checked={signoff} onChange={(e) => setSignoff(e.target.checked)} /> Sign off</label>
          <span className="grow" />
          <span className="count">{msg.split("\n")[0].length}</span>
        </div>
        <button className="btn primary wide" disabled={!msg.trim() || !!busy || (!amend && staged.length === 0)} onClick={() => void doCommit()}>
          {amend ? "Amend last commit" : staged.length ? `Commit ${staged.length} file${staged.length === 1 ? "" : "s"}` : "Stage files to commit"}
        </button>
      </div>
    </div>
  );
}

const SIG: Record<string, string> = { G: "Verified signature", U: "Signed (untrusted key)", B: "BAD signature", E: "Signed (cannot verify)", X: "Signed (expired)", Y: "Signed (expired key)", R: "Signed (revoked key)" };

function CommitPanel({ hash }: { hash: string }) {
  const d = useStore((s) => s.details);
  const commit = useStore((s) => s.commits.find((c) => c.hash === hash));
  const isReviewed = useStore((s) => !!s.reviewed[hash]);
  const agent = commit ? aiAgent(commit) : null;
  const openFile = useStore((s) => s.openFile);
  if (!d || d.hash !== hash) return <div className="panel"><div className="hint">Loading…</div></div>;
  const [title, ...rest] = d.message.split("\n");
  const body = rest.join("\n").trim();
  const open = (f: ChangedFile, view: "diff" | "blame" | "history" = "diff") => st().setOpenFile({ kind: "commit", path: f.path, hash: d.hash, oldPath: f.oldPath, view });
  return (
    <div className="panel">
      <div className="cd-head">
        <div className="cd-title">{title}</div>
        {body && <pre className="cd-body">{body}</pre>}
        <div className="cd-meta">
          <Avatar name={d.author} email={d.email} size={36} editable />
          <div>
            <div><b>{d.author}</b> <span className="dim">&lt;{d.email}&gt;</span></div>
            <div className="dim">{fullDate(d.time)}</div>
            {d.committer !== d.author && <div className="dim">Committed by {d.committer}</div>}
          </div>
        </div>
        <div className="cd-ids">
          <span className="mono sel" title="Click to copy" onClick={() => navigator.clipboard.writeText(d.hash).then(() => st().toast("ok", "Hash copied"), () => {})}>{d.hash.slice(0, 10)}</span>
          {d.parents.map((p) => (
            <span key={p} className="mono link" title="Go to parent" onClick={() => st().select({ type: "commit", hash: p }, true)}>↑ {p.slice(0, 7)}</span>
          ))}
          {d.signature !== "N" && SIG[d.signature] && <span className={`sig ${d.signature === "G" ? "good" : d.signature === "B" ? "bad" : ""}`}>{SIG[d.signature]}</span>}
        </div>
      </div>
      <div className="section-h"><span>{d.files.length} changed file{d.files.length === 1 ? "" : "s"}</span><span className="grow" />{agent && <button className={`link${isReviewed ? " ok" : ""}`} title="Mark this AI-assisted commit as reviewed by you (r). Unreviewed ones are flagged before a push." onClick={() => st().toggleReviewed(d.hash)}>{isReviewed ? "✓ Reviewed" : "Mark reviewed"}</button>}<button className="link" onClick={() => A.copyForAi("commit", d.hash)}>Copy for AI</button><button className="link" title="Every file in one scroll (Enter)" onClick={() => A.reviewAll("commit", d.hash)}>Review all</button></div>
      <div className="files tall">
        {d.files.map((f) => (
          <div key={f.path} className={`file${openFile?.path === f.path ? " active" : ""}`} onClick={() => open(f)}
            onContextMenu={(e) => { e.preventDefault(); st().set({ menu: { x: e.clientX, y: e.clientY, items: [
              { label: "View diff", onClick: () => open(f) },
              { label: "Blame at this commit", disabled: f.status === "D", onClick: () => open(f, "blame") },
              { label: "File history", onClick: () => open(f, "history") },
            ] } }); }}>
            <Badge code={f.status} />
            <FileName path={f.path} />
          </div>
        ))}
      </div>
    </div>
  );
}

export function Panel() {
  const selected = useStore((s) => s.selected);
  const status = useStore((s) => s.status);
  const repo = useStore((s) => s.repo);
  useEffect(() => {
    // Jump straight to the staging view when there is work in progress and nothing selected.
    if (!selected && status && (status.files.length > 0 || status.state)) st().select({ type: "wip" });
  }, [selected, status]);
  if (selected?.type === "wip") return <WipPanel key={repo?.path} />;
  if (selected?.type === "commit") return <CommitPanel hash={selected.hash} />;
  return (
    <div className="panel">
      <div className="placeholder">
        <img src="/axolotl.svg" width={96} height={96} alt="" />
        <div>Select a commit to see its details</div>
        <div className="dim">Right-click commits, branches and files for more actions.</div>
      </div>
    </div>
  );
}
