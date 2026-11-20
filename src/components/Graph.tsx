import { memo, useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import { A, commitMenu } from "../actions";
import { aiAgent } from "../ai";
import type { Commit } from "../api";
import { laneColor, layoutGraph } from "../graph";
import type { GraphRow } from "../graph";
import { fmtDate, fullDate, st, useStore } from "../store";
import { Avatar } from "./Icon";

const H = 28;
const LANE = 16;
const MAX_LANES = 14;
const x = (lane: number) => 12 + Math.min(lane, MAX_LANES) * LANE;

interface Chip { label: string; kind: "head" | "remote" | "tag"; current: boolean }

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
  return out;
}

const GraphCell = memo(function GraphCell({ row, width, isHead }: { row: GraphRow; width: number; isHead: boolean }) {
  const cx = x(row.col);
  const m = H / 2;
  return (
    <svg width={width} height={H} className="graph-cell" style={{ color: laneColor(row.color) }}>
      {row.through.map(([l, c]) => <line key={`t${l}`} x1={x(l)} y1={0} x2={x(l)} y2={H} style={{ stroke: laneColor(c) }} />)}
      {row.ins.map(([l, c]) => (
        <path key={`i${l}`} d={l === row.col ? `M${cx} 0V${m}` : `M${x(l)} 0C${x(l)} ${m * 0.8} ${cx} ${m * 0.3} ${cx} ${m}`} style={{ stroke: laneColor(c) }} fill="none" />
      ))}
      {row.outs.map(([l, c]) => (
        <path key={`o${l}`} d={l === row.col ? `M${cx} ${m}V${H}` : `M${cx} ${m}C${cx} ${m + m * 0.7} ${x(l)} ${m + m * 0.2} ${x(l)} ${H}`} style={{ stroke: laneColor(c) }} fill="none" />
      ))}
      {isHead && <circle className="head-ring" cx={cx} cy={m} r={7.5} fill="none" style={{ stroke: laneColor(row.color) }} strokeWidth={1.5} />}
      <circle className="node" cx={cx} cy={m} r={row.merge ? 3.5 : 4.5} style={{ fill: row.merge ? "var(--bg)" : laneColor(row.color), stroke: laneColor(row.color) }} strokeWidth={2} />
    </svg>
  );
});

const Row = memo(function Row({ c, row, width, selected, isHead, top, reviewed }: { c: Commit; row: GraphRow | null; width: number; selected: boolean; isHead: boolean; top: number; reviewed: boolean }) {
  const ai = aiAgent(c);
  return (
    <div
      className={`row${selected ? " selected" : ""}`}
      style={{ top, height: H }}
      onClick={() => st().select({ type: "commit", hash: c.hash })}
      onContextMenu={(e) => { st().select({ type: "commit", hash: c.hash }); commitMenu(e, c); }}
    >
      {row && <GraphCell row={row} width={width} isHead={isHead} />}
      <div className="row-msg">
        {chips(c.refs).map((ch) => (
          <span
            key={ch.kind + ch.label}
            className={`chip ${ch.kind}${ch.current ? " current" : ""}${row && ch.kind !== "tag" ? " lane" : ""}`}
            style={row && ch.kind !== "tag" ? ({ "--chip": laneColor(row.color) } as React.CSSProperties) : undefined}
            title={ch.kind === "tag" ? `Tag ${ch.label}` : `Double-click to check out ${ch.label}`}
            onDoubleClick={(e) => { e.stopPropagation(); if (!ch.current) void A.checkout(ch.label, ch.kind); }}
          >
            {ch.kind === "tag" ? "🏷 " : ch.kind === "remote" ? "☁ " : ch.current ? "✓ " : ""}{ch.label}
          </span>
        ))}
        <span className="subject">{c.subject}</span>
      </div>
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

  const layout = useMemo(() => layoutGraph(commits), [commits]);
  const q = search.trim().toLowerCase();
  const view = useMemo(() => {
    if (!q && !aiOnly) return commits.map((c, i) => ({ c, row: layout.rows[i] as GraphRow | null }));
    return commits
      .filter((c) => !aiOnly || aiAgent(c))
      .filter((c) => !q || c.coauthors.some((a) => a.toLowerCase().includes(q)) || c.subject.toLowerCase().includes(q) || c.author.toLowerCase().includes(q) || c.hash.startsWith(q) || c.refs.some((r) => r.toLowerCase().includes(q)))
      .map((c) => ({ c, row: null as GraphRow | null }));
  }, [commits, layout, q, aiOnly]);

  const wipCount = status?.files.length ?? 0;
  const showWip = !q && !aiOnly && (wipCount > 0 || !!status?.state);
  const offset = showWip ? 1 : 0;
  const total = view.length + offset;
  const width = Math.min(layout.maxCols, MAX_LANES + 1) * LANE + 12;

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
      if (y < el.scrollTop || y > el.scrollTop + el.clientHeight - H) el.scrollTop = Math.max(0, y - el.clientHeight / 2);
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
          <svg width={width} height={H} className="graph-cell">
            <circle cx={12} cy={H / 2} r={5} fill="none" stroke="var(--accent)" strokeWidth={2} strokeDasharray="3 2" />
          </svg>
          <div className="row-msg">
            <span className="chip wipchip">{status?.state ? status.state.toUpperCase() + " IN PROGRESS" : "WIP"}</span>
            <span className="subject">{wipCount} uncommitted change{wipCount === 1 ? "" : "s"}</span>
          </div>
        </div>,
      );
      continue;
    }
    const v = view[i - offset];
    items.push(
      <Row key={v.c.hash} c={v.c} row={v.row} width={width} top={i * H} reviewed={!!reviewed[v.c.hash]}
        selected={selected?.type === "commit" && selected.hash === v.c.hash} isHead={v.c.hash === status?.head} />,
    );
  }

  return (
    <div
      className="graph"
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
      <div style={{ height: total * H, position: "relative" }}>{items}</div>
      {total === 0 && (
        <div className="empty">
          {q ? "No commits match your search." : "No commits yet. Stage some files and make your first commit!"}
        </div>
      )}
    </div>
  );
}
