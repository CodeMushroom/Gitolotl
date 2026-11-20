import { useState } from "react";
import type { ReactNode } from "react";
import { A, backupMenu, describe, openExternal, prMenu, refMenu, remoteMenu, stashMenu } from "../actions";
import type { RefInfo } from "../api";
import { primaryFirst } from "../branches";
import { fmtDate, st, useStore } from "../store";

function Section({ title, count, action, children }: { title: string; count: number; action?: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="sb-section">
      <div className="sb-h" onClick={() => setOpen(!open)}>
        <span className="caret">{open ? "▾" : "▸"}</span>
        <span>{title}</span>
        <span className="sb-count">{count}</span>
        <span className="grow" />
        <span onClick={(e) => e.stopPropagation()}>{action}</span>
      </div>
      {open && children}
    </div>
  );
}

function RefItem({ r, label }: { r: RefInfo; label?: string }) {
  return (
    <div
      className={`sb-item${r.isHead ? " current" : ""}`}
      title={r.kind === "tag" ? r.short : `${r.short} — double-click to check out`}
      onClick={() => st().select({ type: "commit", hash: r.hash }, true)}
      onDoubleClick={() => { if (!r.isHead) void A.checkout(r.short, r.kind); }}
      onContextMenu={(e) => refMenu(e, r)}
    >
      <span className="sb-icon">{r.isHead ? "✓" : r.kind === "tag" ? "🏷" : r.kind === "remote" ? "☁" : "⑂"}</span>
      <span className="sb-name">{label ?? r.short}</span>
      {r.gone && <span className="pill warn" title="Upstream branch was deleted">gone</span>}
      {r.ahead > 0 && <span className="pill">↑{r.ahead}</span>}
      {r.behind > 0 && <span className="pill">↓{r.behind}</span>}
    </div>
  );
}

export function Sidebar() {
  const refs = useStore((s) => s.refs);
  const remotes = useStore((s) => s.remotes);
  const stashes = useStore((s) => s.stashes);
  const worktrees = useStore((s) => s.worktrees);
  const backups = useStore((s) => s.backups);
  const prs = useStore((s) => s.prs);
  const gh = useStore((s) => s.gh);
  const [filter, setFilter] = useState("");
  const f = filter.trim().toLowerCase();
  const match = (s: string) => !f || s.toLowerCase().includes(f);

  const defaultBranch = useStore((s) => s.defaultBranch);
  // main / master / staging and friends stay at the top, however many branches there are
  const heads = primaryFirst(refs.filter((r) => r.kind === "head" && match(r.short)), (r) => r.short, defaultBranch);
  const pinEnd = (g: { pinned: unknown[]; rest: unknown[] }) => g.pinned.length > 0 && g.rest.length > 0 && <div className="sb-pin-end" />;
  const tags = refs.filter((r) => r.kind === "tag" && match(r.short)).reverse();
  const remoteRefs = refs.filter((r) => r.kind === "remote" && match(r.short));

  return (
    <div className="sidebar">
      <input className="sb-filter" placeholder="Filter branches, tags…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      <div className="sb-scroll">
        <Section title="Local" count={heads.pinned.length + heads.rest.length} action={<button className="mini" title="New branch" onClick={() => A.newBranch()}>+</button>}>
          {heads.pinned.map((r) => <RefItem key={r.name} r={r} />)}
          {pinEnd(heads)}
          {heads.rest.map((r) => <RefItem key={r.name} r={r} />)}
        </Section>
        <Section title="Remote" count={remoteRefs.length} action={<button className="mini" title="Add remote" onClick={() => A.addRemote()}>+</button>}>
          {remotes.map((rm) => (
            <div key={rm.name}>
              <div className="sb-sub" title={rm.url} onContextMenu={(e) => remoteMenu(e, rm.name)}>{rm.name}</div>
              {(() => {
                const g = primaryFirst(remoteRefs.filter((r) => r.short.startsWith(rm.name + "/")), (r) => r.short.slice(rm.name.length + 1), defaultBranch);
                const item = (r: RefInfo) => <RefItem key={r.name} r={r} label={r.short.slice(rm.name.length + 1)} />;
                return <>{g.pinned.map(item)}{pinEnd(g)}{g.rest.map(item)}</>;
              })()}
            </div>
          ))}
          {remotes.length === 0 && <div className="hint">No remotes yet</div>}
        </Section>
        {gh && (
          <Section title="Pull requests" count={prs.length} action={<button className="mini" title="Open a pull request" onClick={() => A.createPr()}>+</button>}>
            {prs.filter((p) => match(p.title) || match(p.head)).map((p) => (
              <div key={p.number} className="sb-item" title={`${p.title}\n${p.head} → ${p.base} by ${p.author}\nDouble-click to open on GitHub`}
                onDoubleClick={() => openExternal(p.url)} onContextMenu={(e) => prMenu(e, p)}>
                <span className="sb-icon">{p.draft ? "◌" : "⇄"}</span>
                <span className="sb-name">#{p.number} {p.title}</span>
              </div>
            ))}
            {!gh.login && <button className="link sb-link" onClick={() => st().loadGithub(true)}>Connect GitHub account</button>}
            {gh.login && prs.length === 0 && <div className="hint">No open pull requests</div>}
          </Section>
        )}
        {worktrees.length > 1 && (
          <Section title="Worktrees" count={worktrees.length} action={<button className="mini" title="Worktree dashboard" onClick={() => A.worktrees()}>▦</button>}>
            {worktrees.map((w) => (
              <div key={w.path} className={`sb-item${w.current ? " current" : ""}`} title={`${w.path}\nDouble-click to open in a tab`}
                onClick={() => w.head && st().select({ type: "commit", hash: w.head }, true)} onDoubleClick={() => !w.current && st().openRepo(w.path)}>
                <span className="sb-icon">{w.current ? "✓" : "⧉"}</span>
                <span className="sb-name">{w.branch ?? w.head.slice(0, 7)} <span className="dim">· {w.path.split("/").pop()}</span></span>
              </div>
            ))}
          </Section>
        )}
        <Section title="Stashes" count={stashes.length} action={<button className="mini" title="Stash changes" onClick={() => A.stash()}>+</button>}>
          {stashes.map((x) => (
            <div key={x.hash} className="sb-item" title={`${x.message}\n${fmtDate(x.time)}`} onClick={() => st().select({ type: "commit", hash: x.hash })} onContextMenu={(e) => stashMenu(e, x)}>
              <span className="sb-icon">▤</span>
              <span className="sb-name">{x.message}</span>
            </div>
          ))}
        </Section>
        {backups.length > 0 && (
          <Section title="Safety snapshots" count={backups.length} action={<button className="mini" title="Undo the most recent one (Ctrl+Z)" onClick={() => A.undo()}>↶</button>}>
            {backups.slice(0, 50).map((b) => (
              <div key={b.name} className="sb-item" title={`Saved before: ${b.label}\n${b.subject}\nRight-click to restore`}
                onClick={() => st().select({ type: "commit", hash: b.hash })} onContextMenu={(e) => backupMenu(e, b)}>
                <span className="sb-icon">⛑</span>
                <span className="sb-name">{describe(b)} <span className="dim">· {fmtDate(b.time)}</span></span>
              </div>
            ))}
          </Section>
        )}
        <Section title="Tags" count={tags.length} action={<button className="mini" title="New tag" onClick={() => A.newTag()}>+</button>}>
          {tags.slice(0, 300).map((r) => <RefItem key={r.name} r={r} />)}
        </Section>
      </div>
    </div>
  );
}
