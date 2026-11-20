import { useEffect, useMemo, useRef, useState } from "react";
import { A } from "../actions";
import { aiAgent } from "../ai";
import { st, useStore } from "../store";

interface Item { kind: string; label: string; hint?: string; run: () => void }

/** Subsequence fuzzy match; lower score is better, -1 means no match. */
function fuzzy(q: string, text: string): number {
  const t = text.toLowerCase();
  const direct = t.indexOf(q);
  if (direct !== -1) return direct;
  let i = 0;
  let score = 100;
  for (const ch of q) {
    const j = t.indexOf(ch, i);
    if (j === -1) return -1;
    score += j - i;
    i = j + 1;
  }
  return score;
}

export function Palette() {
  const open = useStore((s) => s.palette);
  const refs = useStore((s) => s.refs);
  const commits = useStore((s) => s.commits);
  const worktrees = useStore((s) => s.worktrees);
  const selected = useStore((s) => s.selected);
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => { if (open) { setQ(""); setIdx(0); } }, [open]);

  const items = useMemo<Item[]>(() => {
    if (!open) return [];
    const hash = selected?.type === "commit" ? selected.hash : undefined;
    const base: Item[] = [
      { kind: "Action", label: "Fetch all remotes", run: () => A.fetch() },
      { kind: "Action", label: "Pull", run: () => A.pull() },
      { kind: "Action", label: "Pull with rebase", run: () => A.pull("rebase") },
      { kind: "Action", label: "Push", run: () => A.push() },
      { kind: "Action", label: "Force push (with lease)", run: () => A.forcePush() },
      { kind: "Action", label: "Create branch", run: () => A.newBranch() },
      { kind: "Action", label: "Create tag", run: () => A.newTag() },
      { kind: "Action", label: "Stash changes", run: () => A.stash() },
      { kind: "Action", label: "Pop latest stash", run: () => A.stashOp("pop", 0) },
      { kind: "Action", label: "Open pull request on GitHub", run: () => A.createPr() },
      { kind: "Review", label: "Review all unstaged changes", hint: "one scroll, stage by hunk", run: () => A.reviewAll("worktree") },
      { kind: "Review", label: "Review all staged changes", run: () => A.reviewAll("staged") },
      { kind: "AI", label: "Copy staged diff for AI", hint: "commit message / review prompt", run: () => A.copyForAi("staged") },
      { kind: "AI", label: "Copy unstaged diff for AI", run: () => A.copyForAi("worktree") },
      ...(hash ? [
        { kind: "AI", label: "Copy selected commit diff for AI", run: () => A.copyForAi("commit", hash) },
        { kind: "Review", label: "Review selected commit (all files)", run: () => A.reviewAll("commit", hash) },
      ] : []),
      { kind: "AI", label: st().aiOnly ? "Show all commits" : "Show only AI-assisted commits", run: () => st().set({ aiOnly: !st().aiOnly }) },
      { kind: "Action", label: "Undo last destructive action", hint: "Ctrl+Z", run: () => A.undo() },
      { kind: "View", label: "Worktree dashboard", hint: "see every checkout and agent", run: () => A.worktrees() },
      { kind: "View", label: "Go to uncommitted changes", run: () => st().select({ type: "wip" }) },
      { kind: "View", label: "Refresh", run: () => void st().refresh() },
      { kind: "App", label: "Open repository…", run: () => void A.openDialog() },
      { kind: "App", label: "Clone repository…", run: () => A.clone() },
      { kind: "App", label: "Settings", run: () => void A.settings() },
      { kind: "App", label: "Check for updates", run: () => void A.checkForUpdates(true) },
    ];
    for (const r of refs) {
      if (r.kind === "tag") base.push({ kind: "Tag", label: r.short, run: () => st().select({ type: "commit", hash: r.hash }, true) });
      else if (!r.isHead) base.push({ kind: "Checkout", label: r.short, hint: r.kind === "remote" ? "remote" : undefined, run: () => void A.checkout(r.short, r.kind) });
    }
    for (const w of worktrees) if (!w.current) base.push({ kind: "Worktree", label: w.branch ?? w.head.slice(0, 7), hint: w.path, run: () => void st().openRepo(w.path) });
    return base;
  }, [open, refs, worktrees, selected]);

  const results = useMemo(() => {
    const query = q.trim().toLowerCase();
    if (!query) return items.slice(0, 60);
    const scored = items
      .map((it) => ({ it, s: fuzzy(query, `${it.kind} ${it.label}`) }))
      .filter((x) => x.s !== -1)
      .sort((a, b) => a.s - b.s)
      .map((x) => x.it);
    // commits: jump by message, author, hash or AI agent
    let n = 0;
    for (const c of commits) {
      if (n >= 30) break;
      if (c.hash.startsWith(query) || c.subject.toLowerCase().includes(query) || c.author.toLowerCase().includes(query) || (aiAgent(c) ?? "").toLowerCase() === query) {
        scored.push({ kind: "Commit", label: c.subject, hint: `${c.hash.slice(0, 7)} · ${c.author}`, run: () => st().select({ type: "commit", hash: c.hash }, true) });
        n++;
      }
    }
    return scored.slice(0, 80);
  }, [q, items, commits]);

  useEffect(() => { setIdx(0); }, [q]);
  useEffect(() => { listRef.current?.querySelector(".on")?.scrollIntoView({ block: "nearest" }); }, [idx]);

  if (!open) return null;
  const run = (it?: Item) => {
    st().set({ palette: false });
    it?.run();
  };
  return (
    <div className="backdrop" onMouseDown={() => st().set({ palette: false })}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          autoFocus
          spellCheck={false}
          placeholder="Type a command, branch, tag, or commit…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setIdx((i) => Math.min(results.length - 1, i + 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setIdx((i) => Math.max(0, i - 1)); }
            else if (e.key === "Enter") { e.preventDefault(); run(results[idx]); }
          }}
        />
        <div className="palette-list" ref={listRef}>
          {results.map((it, i) => (
            <div key={`${it.kind}:${it.label}:${i}`} className={`palette-item${i === idx ? " on" : ""}`} onMouseEnter={() => setIdx(i)} onClick={() => run(it)}>
              <span className="palette-kind">{it.kind}</span>
              <span className="subject">{it.label}</span>
              {it.hint && <span className="dim subject" style={{ flex: "0 1 auto", maxWidth: "45%" }}>{it.hint}</span>}
            </div>
          ))}
          {results.length === 0 && <div className="hint">No matches</div>}
        </div>
        <div className="palette-foot">
          <span>↑↓ navigate</span><span>Enter run</span><span>Esc close</span>
          <span className="grow" />
          <span>j/k commits · Enter review · r reviewed · c copy for AI · w changes · Ctrl+Z undo</span>
        </div>
      </div>
    </div>
  );
}
