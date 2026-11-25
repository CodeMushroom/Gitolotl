import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { primaryRank } from "../branches";
import { fmtDate, st } from "../store";

const DAY = 86400;
/** a branch nobody has committed to for this long is offered (not ticked) */
const OLD_BRANCH = 180 * DAY;
const OLD_STASH = 90 * DAY;

interface Item {
  id: string;
  group: "Worktrees" | "Branches" | "Stashes";
  title: string;
  why: string;
  /** ticked to begin with: there is a clear sign it is finished with */
  on: boolean;
  run: (repo: string) => Promise<unknown>;
}

async function scan(repo: string): Promise<Item[]> {
  const [refs, stashes, worktrees, remoteDefault] = await Promise.all([
    api.refs(repo), api.stashes(repo), api.worktreeDetails(repo), api.defaultBranch(repo).catch(() => null),
  ]);
  const heads = refs.filter((r) => r.kind === "head");
  const primary = (name: string) => primaryRank(name, remoteDefault) >= 0;
  // what "merged" is measured against: the remote's default branch, else a local main / master
  const into = remoteDefault ?? heads.filter((r) => primary(r.short)).sort((a, b) => primaryRank(a.short, null) - primaryRank(b.short, null))[0]?.short ?? null;
  const merged = new Set(into ? await api.mergedBranches(repo, into).catch(() => [] as string[]) : []);
  const now = Date.now() / 1000;

  /** Why a branch looks finished with, or null when it does not. */
  const verdict = (name: string): { why: string; on: boolean } | null => {
    const r = heads.find((h) => h.short === name);
    if (!r || r.isHead || primary(name)) return null;
    if (r.gone) return { why: "its remote branch was deleted", on: true };
    if (merged.has(name)) return r.upstream ? { why: `merged into ${into}`, on: true } : { why: `has no commits that ${into} lacks, and was never pushed`, on: false };
    if (r.time && now - r.time > OLD_BRANCH) return { why: `no commits since ${fmtDate(r.time)}`, on: false };
    return null;
  };

  const items: Item[] = [];
  const held = new Set<string>();
  worktrees.forEach((w, i) => {
    if (w.branch) held.add(w.branch);
    // the first one is the repository's own folder, which is never removed
    if (i === 0 || w.current) return;
    const folder = w.path.split("/").pop() ?? w.path;
    if (w.missing) {
      items.push({ id: `w:${w.path}`, group: "Worktrees", title: folder, why: `its folder no longer exists (${w.path}); only git's record of it is removed`, on: true, run: (r) => api.removeWorktree(r, w.path) });
      return;
    }
    const v = w.branch && w.dirty === 0 ? verdict(w.branch) : null;
    if (!v || !w.branch) return;
    const branch = w.branch;
    items.push({
      id: `w:${w.path}`, group: "Worktrees", title: `${folder} and its branch ${branch}`, why: `nothing uncommitted, and ${v.why}`, on: v.on,
      run: async (r) => { await api.removeWorktree(r, w.path); await api.deleteBranch(r, branch, true); },
    });
  });
  for (const r of heads) {
    const v = held.has(r.short) ? null : verdict(r.short);
    if (v) items.push({ id: `b:${r.short}`, group: "Branches", title: r.short, why: v.why, on: v.on, run: (repo) => api.deleteBranch(repo, r.short, true) });
  }
  // Highest number first: dropping a stash renumbers the ones after it.
  for (const x of [...stashes].reverse()) {
    if (now - x.time > OLD_STASH) items.push({ id: `s:${x.hash}`, group: "Stashes", title: x.message, why: `saved ${fmtDate(x.time)}`, on: false, run: (repo) => api.stashOp(repo, "drop", x.index, x.hash) });
  }
  return items;
}

const GROUPS = ["Worktrees", "Branches", "Stashes"] as const;

/** Offers what looks finished with. Nothing is removed that the user did not tick. */
export function Cleanup() {
  const repo = st().repo?.path ?? "";
  const [items, setItems] = useState<Item[] | null>(null);
  const [sel, setSel] = useState<Record<string, boolean>>({});
  const [err, setErr] = useState("");
  const [done, setDone] = useState("");
  const [working, setWorking] = useState(false);

  const load = useCallback(() => {
    scan(repo).then((found) => {
      setItems(found);
      setSel(Object.fromEntries(found.map((i) => [i.id, i.on])));
    }).catch((e) => setErr(String(e)));
  }, [repo]);
  useEffect(load, [load]);

  const picked = items?.filter((i) => sel[i.id]) ?? [];
  const go = async () => {
    setWorking(true);
    setErr("");
    const failed: string[] = [];
    let ok = 0;
    await st().act("Cleaning up", async (r) => {
      for (const i of picked) {
        try { await i.run(r); ok++; } catch (e) { failed.push(`${i.title}: ${String(e)}`); }
      }
    }, true);
    setDone(ok ? `Removed ${ok} item${ok === 1 ? "" : "s"}. Branches and stashes are in Safety snapshots if you want one back.` : "");
    setErr(failed.join("\n"));
    setWorking(false);
    load();
  };

  return (
    <div className="modal wide" onMouseDown={(e) => e.stopPropagation()}>
      <h3>Clean up</h3>
      <p className="dim">
        These look finished with. Tick what should go; nothing else is touched. Deleted branches and dropped stashes are kept as safety snapshots.
        A removed worktree folder is deleted from disk, with any ignored files in it (build output, local settings); git refuses if it holds uncommitted work.
      </p>
      {done && <div className="cl-done">{done}</div>}
      {err && <div className="form-err">{err}</div>}
      <div className="cl-list">
        {!items && !err && <div className="hint">Looking…</div>}
        {items?.length === 0 && <div className="hint">Nothing looks old or finished with.</div>}
        {GROUPS.map((g) => {
          const rows = items?.filter((i) => i.group === g) ?? [];
          if (!rows.length) return null;
          const all = rows.every((i) => sel[i.id]);
          return (
            <div key={g}>
              <label className="cl-h">
                <input type="checkbox" checked={all} onChange={() => setSel((o) => ({ ...o, ...Object.fromEntries(rows.map((i) => [i.id, !all])) }))} />
                <span>{g}</span>
                <span className="sb-count">{rows.filter((i) => sel[i.id]).length} of {rows.length}</span>
              </label>
              {rows.map((i) => (
                <label key={i.id} className="cl-row" title={`${i.title}\n${i.why}`}>
                  <input type="checkbox" checked={!!sel[i.id]} onChange={(e) => setSel((o) => ({ ...o, [i.id]: e.target.checked }))} />
                  <b>{i.title}</b>
                  <span className="dim">{i.why}</span>
                </label>
              ))}
            </div>
          );
        })}
      </div>
      <div className="modal-btns">
        <button className="btn" onClick={() => st().set({ modal: null })}>Close</button>
        <button className="btn danger" disabled={working || picked.length === 0} onClick={() => void go()}>
          {working ? "Working…" : picked.length ? `Remove ${picked.length} item${picked.length === 1 ? "" : "s"}` : "Nothing ticked"}
        </button>
      </div>
    </div>
  );
}
