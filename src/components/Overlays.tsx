import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { pickFolder } from "../actions";
import { api } from "../api";
import type { TodoCommit } from "../api";
import { st, useStore } from "../store";
import type { FormModal, Values } from "../store";
import { Cleanup } from "./Cleanup";
import { Worktrees } from "./Worktrees";

function Form({ m }: { m: FormModal }) {
  const [v, setV] = useState<Values>(() => Object.fromEntries((m.fields ?? []).map((f) => [f.key, f.value ?? (f.type === "checkbox" ? false : "")])));
  const [err, setErr] = useState("");
  const [working, setWorking] = useState(false);
  const upd = (k: string, val: string | boolean) => setV((o) => ({ ...o, [k]: val, ...m.onChange?.(k, val, o) }));
  const submit = async () => {
    if (working) return;
    setWorking(true);
    setErr("");
    try {
      await m.onSubmit(v);
      if (st().modal === m) st().set({ modal: null });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    setWorking(false);
  };
  return (
    <form className="modal" onSubmit={(e) => { e.preventDefault(); void submit(); }} onMouseDown={(e) => e.stopPropagation()}>
      <h3>{m.title}</h3>
      {m.message && <p className="dim pre">{m.message}</p>}
      {(m.fields ?? []).map((f, i) => (
        f.type === "checkbox" ? (
          <label key={f.key} className="check"><input type="checkbox" checked={!!v[f.key]} onChange={(e) => upd(f.key, e.target.checked)} /> {f.label}</label>
        ) : (
          <label key={f.key} className="field">
            <span>{f.label}</span>
            {f.type === "text" && <input autoFocus={i === 0} value={String(v[f.key])} placeholder={f.placeholder} spellCheck={false} onChange={(e) => upd(f.key, e.target.value)} />}
            {f.type === "textarea" && <textarea rows={5} value={String(v[f.key])} onChange={(e) => upd(f.key, e.target.value)} />}
            {f.type === "select" && <select value={String(v[f.key])} onChange={(e) => upd(f.key, e.target.value)}>{f.options?.map(([val, label]) => <option key={val} value={val}>{label}</option>)}</select>}
            {f.type === "folder" && (
              <div className="folder">
                <input readOnly value={String(v[f.key])} placeholder="Choose a folder…" />
                <button type="button" className="btn" onClick={async () => { const p = await pickFolder(); if (p) upd(f.key, p); }}>Browse…</button>
              </div>
            )}
          </label>
        )
      ))}
      {err && <div className="form-err">{err}</div>}
      <div className="modal-btns">
        <button type="button" className="btn" autoFocus={m.cautious} onClick={() => st().set({ modal: null })}>Cancel</button>
        {m.alt && <button type="button" className="btn" onClick={m.alt.onClick}>{m.alt.label}</button>}
        <button type="submit" className={`btn ${m.danger ? "danger" : "primary"}`} disabled={working} autoFocus={!m.cautious && !m.fields?.some((f) => f.type === "text")}>{working ? "Working…" : m.confirm ?? "OK"}</button>
      </div>
    </form>
  );
}

type Action = "pick" | "squash" | "fixup" | "drop";

function InteractiveRebase({ from }: { from: string }) {
  const [items, setItems] = useState<(TodoCommit & { action: Action })[] | null>(null);
  const [err, setErr] = useState("");
  const [hasMerge, setHasMerge] = useState(false);
  useEffect(() => {
    const repo = st().repo?.path;
    if (!repo) return;
    api.rebaseCandidates(repo, from).then((c) => {
      // git replays merged-in commits linearly and omits the merge commits themselves
      setHasMerge(c.some((x) => x.merge));
      setItems(c.filter((x) => !x.merge).map((x) => ({ ...x, action: "pick" as Action })));
    }).catch((e) => setErr(String(e)));
  }, [from]);
  const move = (i: number, d: number) => setItems((o) => {
    if (!o || i + d < 0 || i + d >= o.length) return o;
    const n = [...o];
    [n[i], n[i + d]] = [n[i + d], n[i]];
    return n;
  });
  const firstKept = items?.find((i) => i.action !== "drop");
  const invalid = !items?.length || !firstKept || firstKept.action !== "pick";
  const go = async () => {
    if (!items) return;
    st().set({ modal: null });
    await st().act("Interactive rebase", (r) => api.rebaseInteractive(r, from, items.map((i) => ({ action: i.action, hash: i.hash }))));
  };
  return (
    <div className="modal wide" onMouseDown={(e) => e.stopPropagation()}>
      <h3>Interactive rebase</h3>
      <p className="dim">Oldest commit first. Reorder, squash into the commit above, or drop. This rewrites history on the current branch.</p>
      {hasMerge && <div className="form-err">This range contains merge commits. The result will be linear: merged-in commits are replayed and the merge commits themselves are dropped.</div>}
      {err && <div className="form-err">{err}</div>}
      <div className="todo">
        {items?.map((it, i) => (
          <div key={it.hash} className={`todo-row ${it.action}`}>
            <select value={it.action} onChange={(e) => setItems((o) => o!.map((x, j) => (j === i ? { ...x, action: e.target.value as Action } : x)))}>
              <option value="pick">pick</option>
              <option value="squash">squash</option>
              <option value="fixup">fixup</option>
              <option value="drop">drop</option>
            </select>
            <span className="mono dim">{it.hash.slice(0, 7)}</span>
            <span className="subject">{it.subject}</span>
            <button className="mini" disabled={i === 0} onClick={() => move(i, -1)} title="Move earlier">↑</button>
            <button className="mini" disabled={i === items.length - 1} onClick={() => move(i, 1)} title="Move later">↓</button>
          </div>
        ))}
        {!items && !err && <div className="hint">Loading…</div>}
      </div>
      {items && invalid && <div className="form-err">The first kept commit must be “pick”.</div>}
      <div className="modal-btns">
        <button className="btn" onClick={() => st().set({ modal: null })}>Cancel</button>
        <button className="btn primary" disabled={invalid} onClick={() => void go()}>Start rebase</button>
      </div>
    </div>
  );
}

export function ModalHost() {
  const modal = useStore((s) => s.modal);
  if (!modal) return null;
  return (
    <div className="backdrop" onMouseDown={() => st().set({ modal: null })}>
      {modal.kind === "form" ? <Form key={modal.title} m={modal} /> : modal.kind === "worktrees" ? <Worktrees /> : modal.kind === "cleanup" ? <Cleanup /> : <InteractiveRebase from={modal.from} />}
    </div>
  );
}

export function ContextMenu() {
  const menu = useStore((s) => s.menu);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  useLayoutEffect(() => {
    if (!menu || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setPos({ x: Math.min(menu.x, window.innerWidth - r.width - 6), y: Math.min(menu.y, window.innerHeight - r.height - 6) });
  }, [menu]);
  useEffect(() => {
    if (!menu) return;
    const close = () => st().set({ menu: null });
    window.addEventListener("mousedown", close);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => { window.removeEventListener("mousedown", close); window.removeEventListener("blur", close); window.removeEventListener("resize", close); };
  }, [menu]);
  if (!menu) return null;
  return (
    <div className="menu" ref={ref} style={{ left: pos.x, top: pos.y }} onMouseDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()}>
      {menu.items.map((it, i) =>
        it.sep ? <div key={i} className="menu-sep" /> : (
          <button key={i} className={`menu-item${it.danger ? " danger" : ""}`} disabled={it.disabled} onClick={() => { st().set({ menu: null }); it.onClick?.(); }}>{it.label}</button>
        ),
      )}
    </div>
  );
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} onClick={() => st().dismissToast(t.id)} title="Click to dismiss">
          <pre>{t.text}</pre>
        </div>
      ))}
    </div>
  );
}
