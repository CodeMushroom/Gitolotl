import { invoke } from "@tauri-apps/api/core";
import { useEffect } from "react";
import { A } from "./actions";
import { DiffView } from "./components/DiffView";
import { Graph } from "./components/Graph";
import { ContextMenu, ModalHost, Toasts } from "./components/Overlays";
import { Palette } from "./components/Palette";
import { Panel } from "./components/Panel";
import { Sidebar } from "./components/Sidebar";
import { Tabs, Toolbar } from "./components/Toolbar";
import { st, useStore } from "./store";

function Welcome() {
  const recent = useStore((s) => s.recent);
  const busy = useStore((s) => s.busy);
  return (
    <div className="welcome">
      <div className="bubbles" aria-hidden>{[0, 1, 2, 3, 4, 5, 6].map((i) => <span key={i} />)}</div>
      <img className="hero" src="/axolotl.svg" width={132} height={132} alt="" />
      <h1>Gitolotl</h1>
      <p className="dim">A friendly, secure Git client by <b className="maker">CodeMushroom</b>.</p>
      <div className="welcome-btns">
        <button className="btn primary" onClick={() => A.openDialog()}>Open repository</button>
        <button className="btn" onClick={() => A.clone()}>Clone…</button>
        <button className="btn" onClick={() => A.init()}>Init new…</button>
      </div>
      <button className="link" onClick={() => A.checkForUpdates(true)}>Check for updates</button>
      <div className="credit">© 2026 CodeMushroom</div>
      {busy && <div className="busy"><span className="spinner" />{busy}</div>}
      {recent.length > 0 && (
        <div className="recent">
          <div className="section-h"><span>Recent</span></div>
          {recent.map((r) => (
            <div key={r.path} className="recent-item" onClick={() => st().openRepo(r.path)}>
              <b>{r.name}</b>
              <span className="dim">{r.path}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function App() {
  const repo = useStore((s) => s.repo);
  const openFile = useStore((s) => s.openFile);

  useEffect(() => {
    // Restore the last session.
    let active = "";
    try { active = JSON.parse(localStorage.getItem("gitolotl.active") ?? '""'); } catch { /* ignore */ }
    invoke<string | null>("initial_repo")
      .catch(() => null)
      .then((arg) => { if (arg || active) void st().openRepo(arg ?? active); });

    // Look for updates now and every four hours while the app stays open.
    const updates = import.meta.env.DEV ? undefined : setInterval(() => void A.checkForUpdates(), 4 * 3600 * 1000);
    if (!import.meta.env.DEV) void A.checkForUpdates();

    const onFocus = () => void st().refreshStatus();
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement;
      if (mod && (e.key.toLowerCase() === "k" || e.key.toLowerCase() === "p")) {
        e.preventDefault();
        if (st().repo) st().set({ palette: !st().palette });
        return;
      }
      if (mod && !e.shiftKey && e.key.toLowerCase() === "z" && !typing && st().repo && !st().modal) {
        e.preventDefault();
        return void A.undo();
      }
      if (!typing && !mod && !st().modal && !st().palette && st().repo) {
        const s = st();
        const step = e.key === "j" || e.key === "ArrowDown" ? 1 : e.key === "k" || e.key === "ArrowUp" ? -1 : 0;
        if (step && !s.openFile) {
          e.preventDefault();
          const i = s.selected?.type === "commit" ? s.commits.findIndex((c) => c.hash === (s.selected as { hash: string }).hash) : -1;
          const next = s.commits[Math.max(0, Math.min(s.commits.length - 1, i + step))];
          if (next) s.select({ type: "commit", hash: next.hash }, true);
          return;
        }
        if (e.key === "Enter" && s.selected?.type === "commit" && !s.openFile) { e.preventDefault(); return void A.reviewAll("commit", s.selected.hash); }
        if (e.key === "c" && s.selected?.type === "commit") return void A.copyForAi("commit", s.selected.hash);
        if (e.key === "w") return s.select({ type: "wip" });
        if (e.key === "r" && s.selected?.type === "commit") return s.toggleReviewed(s.selected.hash);
        if (e.key === "/") { e.preventDefault(); return void document.querySelector<HTMLInputElement>(".search")?.focus(); }
      }
      if (e.key === "Escape") {
        if (st().palette) st().set({ palette: false });
        else if (st().menu) st().set({ menu: null });
        else if (st().modal) st().set({ modal: null });
        else if (st().openFile) st().setOpenFile(null);
      } else if (e.key === "F5" || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "r")) {
        e.preventDefault();
        void st().refresh();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "o") {
        e.preventDefault();
        void A.openDialog();
      }
    };
    // The native webview menu (reload / inspect) has no place in the app.
    const onCtx = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!(t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement)) e.preventDefault();
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("keydown", onKey);
    window.addEventListener("contextmenu", onCtx);
    const timer = setInterval(() => { if (document.hasFocus()) void st().refreshStatus(); }, 4000);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("contextmenu", onCtx);
      clearInterval(timer);
      clearInterval(updates);
    };
  }, []);

  return (
    <div className="app">
      <Tabs />
      {repo ? (
        <>
          <Toolbar />
          <div className="main">
            <Sidebar />
            <div className="center">{openFile ? <DiffView /> : <Graph />}</div>
            <Panel />
          </div>
        </>
      ) : (
        <Welcome />
      )}
      <Palette />
      <ModalHost />
      <ContextMenu />
      <Toasts />
    </div>
  );
}
