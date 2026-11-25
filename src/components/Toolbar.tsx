import type React from "react";
import { A, pullMenu, pushMenu } from "../actions";
import { st, useStore } from "../store";
import { Icon } from "./Icon";

export function Tabs() {
  const tabs = useStore((s) => s.tabs);
  const repo = useStore((s) => s.repo);
  const busy = useStore((s) => s.busy);
  const update = useStore((s) => s.update);
  return (
    <div className="tabs">
      <img src="/axolotl.svg" className={`logo${busy ? " working" : ""}`} alt="Gitolotl" title="Home" onClick={() => st().goHome()} />
      {tabs.map((t) => (
        <div key={t.path} className={`tab${repo?.path === t.path ? " on" : ""}`} title={t.path} onClick={() => repo?.path !== t.path && st().openRepo(t.path)}>
          <span>{t.name}</span>
          <button className="tab-x" title="Close tab" onClick={(e) => { e.stopPropagation(); st().closeTab(t.path); }}>✕</button>
        </div>
      ))}
      <button className="tab-add" title="Open repository" onClick={() => A.openDialog()}>+</button>
      <span className="grow" />
      {update && <button className="update-pill" title="A new version is ready. Click to see what's new and install it." onClick={() => A.promptUpdate()}>⬆ Update to {update}</button>}
    </div>
  );
}

export function Toolbar() {
  const status = useStore((s) => s.status);
  const busy = useStore((s) => s.busy);
  const search = useStore((s) => s.search);
  const showAll = useStore((s) => s.showAll);
  const stashes = useStore((s) => s.stashes);
  const gh = useStore((s) => s.gh);
  const aiOnly = useStore((s) => s.aiOnly);
  const dirty = (status?.files.length ?? 0) > 0;
  const tb = (icon: string, label: string, onClick: () => void, opts: { disabled?: boolean; badge?: number; onMenu?: (e: React.MouseEvent) => void; title?: string } = {}) => (
    <button className="tb" disabled={!!busy || opts.disabled} onClick={onClick} onContextMenu={opts.onMenu} title={opts.title ?? label}>
      <span className="tb-icon"><Icon name={icon} />{!!opts.badge && <span className="tb-badge">{opts.badge}</span>}</span>
      <span>{label}</span>
    </button>
  );
  return (
    <div className="toolbar">
      <div
        className={`branch-box${status && !status.branch ? " detached" : ""}`}
        title={`${status?.upstream ? `Tracking ${status.upstream}` : "No upstream branch"}\nClick to show this commit in the graph`}
        onClick={() => { if (status?.head) st().select({ type: "commit", hash: status.head }, true); }}
      >
        <span className="dim">{status?.branch ? "branch" : "detached"}</span>
        <b>{status?.branch ?? status?.head.slice(0, 7) ?? "…"}</b>
      </div>
      <div className="tb-group">
        {tb("fetch", "Fetch", () => A.fetch())}
        {tb("pull", "Pull", () => A.pull(), { badge: status?.behind, onMenu: pullMenu, title: "Pull — right-click for rebase / ff-only" })}
        {tb("push", "Push", () => A.push(), { badge: status?.ahead, onMenu: pushMenu, title: "Push — right-click for tags / force push" })}
      </div>
      <div className="tb-group">
        {tb("branch", "Branch", () => A.newBranch())}
        {tb("stash", "Stash", () => A.stash(), { disabled: !dirty })}
        {tb("pop", "Pop", () => A.stashOp("pop", 0), { disabled: stashes.length === 0 })}
      </div>
      {gh && <div className="tb-group">{tb("pr", "PR", () => A.createPr(), { title: "Open a pull request on GitHub" })}</div>}
      <span className="grow" />
      {busy && <span className="busy"><span className="spinner" />{busy}</span>}
      <button className="kbd" title="Command palette" onClick={() => st().set({ palette: true })}>Ctrl K</button>
      <label className="toggle" title="Show only commits written or co-authored by an AI agent">
        <input type="checkbox" checked={aiOnly} onChange={(e) => st().set({ aiOnly: e.target.checked })} /> ✦ AI only
      </label>
      <label className="toggle" title="Show all branches, or only the current one">
        <input type="checkbox" checked={showAll} onChange={(e) => { st().set({ showAll: e.target.checked }); void st().refresh(); }} /> All branches
      </label>
      <input className="search" placeholder="Search commits (message, author, hash)…" value={search} onChange={(e) => st().set({ search: e.target.value })} />
      <button className="iconbtn" title="Refresh (F5)" onClick={() => st().refresh()}><Icon name="fetch" size={16} /></button>
      <button className="iconbtn" title="Settings" onClick={() => A.settings()}><Icon name="settings" size={16} /></button>
    </div>
  );
}
