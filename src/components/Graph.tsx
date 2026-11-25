import { memo, useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import { A, commitMenu } from "../actions";
import { aiAgent } from "../ai";
import type { Commit } from "../api";
import { laneColor, layoutGraph } from "../graph";
import type { GraphRow } from "../graph";
import { fmtDate, fullDate, st, useStore } from "../store";
import { Avatar } from "./Icon";
import { Splitter } from "./Splitter";

const H = 28;
/** height of the column header, which scrolls with nothing and sits above the rows */
const HEAD = 24;
const LANE = 16;
const MAX_LANES = 14;
const x = (lane: number) => 12 + Math.min(lane, MAX_LANES) * LANE;

interface Chip { label: string; kind: "head" | "remote" | "tag"; current: boolean; /** the remote copy sitting on the same commit */ remote?: string }

function chips(refs: string[]): Chip[] {
  const out: Chip[] = [];
  for (let r of refs) {
    let current = false;
    if (r.startsWith("HEAD -> ")) { current = true; r = r.slice(8); }
    if (r.startsWith("tag: ")) r = r.slice(5);
    if (r.startsWith("refs/heads/")) out.push({ label: r.slice(11), kind: "head", current });
    else if (r.startsWith("refs/remotes/")) { if (!r.endsWith("/HEAD")) out.push({ label: r.slice(13), kind: "remote", current }); }
    else if (r.startsWith("refs/tags/")) out.push({ label: r.slice(10), kind: "tag", current });
  }
  // A local branch and its remote copy on the same commit are one label, marked as in sync.
  const local = new Map(out.filter((c) => c.kind === "head").map((c) => [c.label, c]));
  const merged = out.filter((c) => {
    const h = c.kind === "remote" ? local.get(c.label.slice(c.label.indexOf("/") + 1)) : undefined;
    if (!h || h.remote) return true;
    h.remote = c.label;
    return false;
  });
  const rank = (c: Chip) => (c.current ? 0 : c.kind === "head" ? 1 : c.kind === "remote" ? 2 : 3);
  return merged.sort((a, b) => rank(a) - rank(b));
}

/** The Branch / Tag column: the first label, and the rest behind a "+N" that opens on hover. */
const Refs = memo(function Refs({ refs, color }: { refs: string[]; color: number | null }) {
  const cs = chips(refs);
  const chip = (ch: Chip) => (
    <span
      key={ch.kind + ch.label}
      className={`chip ${ch.kind}${ch.current ? " current" : ""}${color !== null && ch.kind !== "tag" ? " lane" : ""}`}
      style={color !== null && ch.kind !== "tag" ? ({ "--chip": laneColor(color) } as React.CSSProperties) : undefined}
      title={ch.kind === "tag" ? `Tag ${ch.label}` : `${ch.label}${ch.current ? " (checked out)" : ""}${ch.remote ? `\nSame commit as ${ch.remote}` : ""}${ch.current ? "" : "\nDouble-click to check out"}`}
      onDoubleClick={(e) => { e.stopPropagation(); if (!ch.current) void A.checkout(ch.label, ch.kind); }}
    >
      {ch.kind === "tag" ? "🏷 " : ch.kind === "remote" ? "☁ " : ch.current ? "✓ " : ""}{ch.label}{ch.remote ? " ☁" : ""}
    </span>
  );
  return (
    <div className={`row-refs${cs.length > 1 ? " many" : ""}`}>
      {cs.length > 0 && chip(cs[0])}
      {cs.length > 1 && <span className="more">+{cs.length - 1}</span>}
      {cs.length > 1 && <span className="rest">{cs.slice(1).map(chip)}</span>}
    </div>
  );
});

/**
 * `wip` is the lane that runs from the top of the graph down to the checked-out commit. It is
 * dashed while there is uncommitted work and not drawn otherwise (the lane stays reserved, so
 * the graph does not shift when you start editing).
 */
const GraphCell = memo(function GraphCell({ row, width, isHead, wip, wipShown }: { row: GraphRow; width: number; isHead: boolean; wip: number; wipShown: boolean }) {
  const cx = x(row.col);
  const m = H / 2;
  const dash = (l: number) => (l === wip ? "3 3" : undefined);
  const drawn = ([l]: [number, number]) => l !== wip || wipShown;
  return (
    <svg width={width} height={H} className="graph-cell" style={{ color: laneColor(row.color) }}>
      {row.through.filter(drawn).map(([l, c]) => <line key={`t${l}`} x1={x(l)} y1={0} x2={x(l)} y2={H} strokeDasharray={dash(l)} style={{ stroke: laneColor(c) }} />)}
      {row.ins.filter(drawn).map(([l, c]) => (
        <path key={`i${l}`} d={l === row.col ? `M${cx} 0V${m}` : `M${x(l)} 0C${x(l)} ${m * 0.8} ${cx} ${m * 0.3} ${cx} ${m}`} strokeDasharray={dash(l)} style={{ stroke: laneColor(c) }} fill="none" />
      ))}
      {row.outs.map(([l, c]) => (
        <path key={`o${l}`} d={l === row.col ? `M${cx} ${m}V${H}` : `M${cx} ${m}C${cx} ${m + m * 0.7} ${x(l)} ${m + m * 0.2} ${x(l)} ${H}`} style={{ stroke: laneColor(c) }} fill="none" />
      ))}
      {isHead && <circle className="head-ring" cx={cx} cy={m} r={7.5} fill="none" style={{ stroke: laneColor(row.color) }} strokeWidth={1.5} />}
      <circle className="node" cx={cx} cy={m} r={row.merge ? 3.5 : 4.5} style={{ fill: row.merge ? "var(--bg)" : laneColor(row.color), stroke: laneColor(row.color) }} strokeWidth={2} />
    </svg>
  );
});

const Row = memo(function Row({ c, row, width, selected, isHead, top, reviewed, wip, wipShown }: { c: Commit; row: GraphRow | null; width: number; selected: boolean; isHead: boolean; top: number; reviewed: boolean; wip: number; wipShown: boolean }) {
  const ai = aiAgent(c);
  return (
    <div
      className={`row${selected ? " selected" : ""}`}
      style={{ top, height: H }}
      onClick={() => st().select({ type: "commit", hash: c.hash })}
      onContextMenu={(e) => { st().select({ type: "commit", hash: c.hash }); commitMenu(e, c); }}
    >
      <Refs refs={c.refs} color={row ? row.color : null} />
      {row && <GraphCell row={row} width={width} isHead={isHead} wip={wip} wipShown={wipShown} />}
      <div className="row-msg"><span className="subject">{c.subject}</span></div>
      {ai && <span className={`aichip${reviewed ? " ok" : ""}`} title={`AI-assisted: ${c.coauthors.join(", ") || c.author}${reviewed ? "\nReviewed by you" : "\nNot yet marked as reviewed (press r)"}`}>{reviewed ? "✓" : "✦"} {ai}</span>}
      <div className="row-author" title={c.email}><Avatar name={c.author} email={c.email} /><span>{c.author}</span></div>
      <div className="row-date" title={fullDate(c.time)}>{fmtDate(c.time)}</div>
      <div className="row-hash">{c.hash.slice(0, 7)}</div>
    </div>
  );
});

export function Graph() {
  const commits = useStore((s) => s.commits);
  const status = useStore((s) => s.status);
  const selected = useStore((s) => s.selected);
  const search = useStore((s) => s.search);
  const scrollTo = useStore((s) => s.scrollTo);
  const limit = useStore((s) => s.limit);
  const aiOnly = useStore((s) => s.aiOnly);
  const reviewed = useStore((s) => s.reviewed);
  const ref = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);

  const q = search.trim().toLowerCase();
  // The checked-out commit anchors the graph: a line runs to it from the very top, where
  // uncommitted work sits, so the branch you are on is always the first lane.
  const head = status?.head ?? "";
  const headIdx = useMemo(() => (q || aiOnly || !head ? -1 : commits.findIndex((c) => c.hash === head)), [commits, head, q, aiOnly]);
  const anchored = headIdx !== -1;
  const layout = useMemo(
    () => layoutGraph(anchored ? [{ hash: "WIP", parents: [head] } as Commit, ...commits] : commits),
    [commits, anchored, head],
  );
  const lead = anchored ? 1 : 0;
  const wipLane = anchored ? layout.rows[0].col : -1;
  const view = useMemo(() => {
    if (!q && !aiOnly) return commits.map((c, i) => ({ c, row: layout.rows[i + lead] as GraphRow | null }));
    return commits
      .filter((c) => !aiOnly || aiAgent(c))
      .filter((c) => !q || c.coauthors.some((a) => a.toLowerCase().includes(q)) || c.subject.toLowerCase().includes(q) || c.author.toLowerCase().includes(q) || c.hash.startsWith(q) || c.refs.some((r) => r.toLowerCase().includes(q)))
      .map((c) => ({ c, row: null as GraphRow | null }));
  }, [commits, layout, lead, q, aiOnly]);

  const wipCount = status?.files.length ?? 0;
  const showWip = !q && !aiOnly && (wipCount > 0 || !!status?.state);
  const stagedCount = status?.files.filter((f) => f.kind === "tracked" && f.x !== ".").length ?? 0;
  const wipColor = anchored ? laneColor(layout.rows[0].color) : "var(--accent)";
  const wipX = anchored ? x(wipLane) : 12;
  const offset = showWip ? 1 : 0;
  const total = view.length + offset;
  // The lane column is as wide as the graph needs, unless the user dragged it narrower.
  const natural = Math.min(layout.maxCols, MAX_LANES + 1) * LANE + 12;
  const cap = useStore((s) => s.layout.graph);
  const width = cap == null ? natural : Math.max(28, Math.min(natural, cap));
  const showGraph = !q && !aiOnly;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!scrollTo || !ref.current) return;
    const i = view.findIndex((v) => v.c.hash === scrollTo);
    if (i !== -1) {
      const y = (i + offset) * H;
      const el = ref.current;
      if (y < el.scrollTop || y > el.scrollTop + el.clientHeight - H - HEAD) el.scrollTop = Math.max(0, y - el.clientHeight / 2);
    }
    st().set({ scrollTo: null });
  }, [scrollTo, view, offset]);

  const first = Math.max(0, Math.floor(scrollTop / H) - 8);
  const last = Math.min(total, Math.ceil((scrollTop + height) / H) + 8);
  const items = [];
  for (let i = first; i < last; i++) {
    if (showWip && i === 0) {
      items.push(
        <div key="wip" className={`row wip${selected?.type === "wip" ? " selected" : ""}`} style={{ top: 0, height: H }} onClick={() => st().select({ type: "wip" })}>
          <div className="row-refs"><span className="chip wipchip">{status?.state ? status.state.toUpperCase() + " IN PROGRESS" : "WIP"}</span></div>
          <svg width={width} height={H} className="graph-cell" style={{ color: wipColor }}>
            {anchored && <line x1={wipX} y1={H / 2 + 5} x2={wipX} y2={H} strokeDasharray="3 3" style={{ stroke: wipColor }} />}
            <circle cx={wipX} cy={H / 2} r={5} fill="none" strokeWidth={2} strokeDasharray="3 2" style={{ stroke: wipColor }} />
          </svg>
          <div className="row-msg">
            <span className="subject">
              {wipCount} uncommitted change{wipCount === 1 ? "" : "s"} on {status?.branch ?? "a detached commit"}
              {wipCount > 0 && ` · ${stagedCount} staged, ${wipCount - stagedCount} not staged`}
            </span>
          </div>
        </div>,
      );
      continue;
    }
    const v = view[i - offset];
    items.push(
      <Row key={v.c.hash} c={v.c} row={v.row} width={width} top={i * H} reviewed={!!reviewed[v.c.hash]}
        wip={anchored && i - offset <= headIdx ? wipLane : -1} wipShown={showWip}
        selected={selected?.type === "commit" && selected.hash === v.c.hash} isHead={v.c.hash === status?.head} />,
    );
  }

  return (
    <div
      className={`graph${width < natural ? " clipped" : ""}`}
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget;
        setScrollTop(el.scrollTop);
        if (!q && !aiOnly && commits.length >= limit && el.scrollTop + el.clientHeight > el.scrollHeight - 600 && !st().busy) {
          st().set({ limit: limit + 3000 });
          void st().refresh();
        }
      }}
    >
      <div className="graph-head">
        <div className="gh-refs"><span>Branch / Tag</span><Splitter k="refs" grow={1} min={70} max={500} className="at-end" /></div>
        {showGraph && <div style={{ width }}><span>Graph</span><Splitter k="graph" grow={1} min={28} max={natural} base={natural} className="at-end" /></div>}
        <div className="gh-msg"><span>Description</span></div>
        <div className="gh-author"><Splitter k="author" grow={-1} min={60} max={400} /><span>Author</span></div>
        <div className="gh-date"><Splitter k="date" grow={-1} min={50} max={200} /><span>Date</span></div>
        <div className="gh-hash"><span>Commit</span></div>
      </div>
      <div style={{ height: total * H, position: "relative" }}>{items}</div>
      {total === 0 && (
        <div className="empty">
          {q ? "No commits match your search." : "No commits yet. Stage some files and make your first commit!"}
        </div>
      )}
    </div>
  );
}
