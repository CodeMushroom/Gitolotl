import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { st, useStore } from "../store";

type Choice = "ours" | "theirs" | "both" | "custom";
interface TextSeg { kind: "text"; lines: string[] }
interface ConflictSeg { kind: "conflict"; ours: string[]; theirs: string[]; oursLabel: string; theirsLabel: string }
type Seg = TextSeg | ConflictSeg;

/** Splits a file with conflict markers into plain text and conflict blocks. Lines keep any trailing \r. */
export function parseConflicts(text: string): Seg[] {
  const segs: Seg[] = [];
  let cur: TextSeg = { kind: "text", lines: [] };
  let c: ConflictSeg | null = null;
  let part: "ours" | "base" | "theirs" = "ours";
  for (const line of text.split("\n")) {
    const bare = line.replace(/\r$/, "");
    if (!c && bare.startsWith("<<<<<<< ")) {
      if (cur.lines.length) segs.push(cur);
      cur = { kind: "text", lines: [] };
      c = { kind: "conflict", ours: [], theirs: [], oursLabel: bare.slice(8), theirsLabel: "" };
      part = "ours";
    } else if (c && bare.startsWith("||||||| ")) part = "base";
    else if (c && bare === "=======") part = "theirs";
    else if (c && bare.startsWith(">>>>>>> ")) {
      c.theirsLabel = bare.slice(8);
      segs.push(c);
      c = null;
    } else if (c) {
      if (part === "ours") c.ours.push(line);
      else if (part === "theirs") c.theirs.push(line);
    } else cur.lines.push(line);
  }
  if (c) return [{ kind: "text", lines: text.split("\n") }]; // unterminated marker: treat as plain text
  if (cur.lines.length) segs.push(cur);
  return segs;
}

export function MergeEditor({ path }: { path: string }) {
  const repo = useStore((s) => s.repo?.path);
  const [segs, setSegs] = useState<Seg[] | null>(null);
  const [error, setError] = useState("");
  const [choice, setChoice] = useState<Record<number, Choice>>({});
  const [custom, setCustom] = useState<Record<number, string>>({});

  useEffect(() => {
    if (!repo) return;
    let live = true;
    setSegs(null); setError(""); setChoice({}); setCustom({});
    api.conflictText(repo, path).then((t) => live && setSegs(parseConflicts(t))).catch((e) => live && setError(String(e)));
    return () => { live = false; };
  }, [repo, path]);

  const conflicts = useMemo(() => (segs ?? []).flatMap((s, i) => (s.kind === "conflict" ? [i] : [])), [segs]);
  const open = conflicts.filter((i) => !choice[i]).length;

  const resolved = (i: number, s: ConflictSeg): string[] => {
    const ch = choice[i];
    if (ch === "ours") return s.ours;
    if (ch === "theirs") return s.theirs;
    if (ch === "both") return [...s.ours, ...s.theirs];
    const crlf = s.ours.concat(s.theirs).some((l) => l.endsWith("\r"));
    return (custom[i] ?? "").split("\n").map((l) => (crlf && !l.endsWith("\r") ? l + "\r" : l));
  };
  const pick = (i: number, s: ConflictSeg, ch: Choice) => {
    setChoice((o) => ({ ...o, [i]: ch }));
    if (ch === "custom" && custom[i] === undefined) setCustom((o) => ({ ...o, [i]: [...s.ours, ...s.theirs].join("\n") }));
  };
  const save = async () => {
    if (!segs || open > 0) return;
    const text = segs.flatMap((s, i) => (s.kind === "text" ? s.lines : resolved(i, s))).join("\n");
    const ok = await st().act(`Resolve ${path}`, (r) => api.resolveWithContent(r, path, text), true);
    if (ok) { st().toast("ok", `${path} resolved and staged`); st().setOpenFile(null); }
  };

  if (error) return <div className="empty err">{error}</div>;
  if (!segs) return <div className="empty">Loading…</div>;
  if (conflicts.length === 0) {
    return (
      <div className="empty">
        No conflict markers in this file (for example one side deleted it).<br />
        Right-click the file and choose <b>Resolve using ours</b> or <b>theirs</b>.
      </div>
    );
  }
  return (
    <div className="merge">
      <div className="merge-bar">
        <span>{conflicts.length} conflict{conflicts.length === 1 ? "" : "s"}{open > 0 ? `, ${open} still to decide` : ", all decided"}</span>
        <span className="grow" />
        <button className="link" onClick={() => setChoice(Object.fromEntries(conflicts.map((i) => [i, "ours" as Choice])))}>All ours</button>
        <button className="link" onClick={() => setChoice(Object.fromEntries(conflicts.map((i) => [i, "theirs" as Choice])))}>All theirs</button>
        <button className="btn primary" disabled={open > 0} onClick={() => void save()}>Save and mark resolved</button>
      </div>
      <div className="merge-body">
        {segs.map((s, i) => {
          if (s.kind === "text") {
            const lines = s.lines.length > 8 ? [...s.lines.slice(0, 3), `⋯ ${s.lines.length - 6} unchanged lines ⋯`, ...s.lines.slice(-3)] : s.lines;
            return <pre key={i} className="merge-ctx">{lines.join("\n").replace(/\r/g, "")}</pre>;
          }
          const ch = choice[i];
          return (
            <div key={i} className={`merge-conflict${ch ? " done" : ""}`}>
              <div className="merge-sides">
                <div className={`merge-side ours${ch === "ours" || ch === "both" ? " on" : ""}`} onClick={() => pick(i, s, "ours")}>
                  <div className="merge-label">Ours · {s.oursLabel}</div>
                  <pre>{s.ours.join("\n").replace(/\r/g, "") || " "}</pre>
                </div>
                <div className={`merge-side theirs${ch === "theirs" || ch === "both" ? " on" : ""}`} onClick={() => pick(i, s, "theirs")}>
                  <div className="merge-label">Theirs · {s.theirsLabel}</div>
                  <pre>{s.theirs.join("\n").replace(/\r/g, "") || " "}</pre>
                </div>
              </div>
              <div className="merge-actions">
                {(["ours", "theirs", "both", "custom"] as Choice[]).map((c) => (
                  <button key={c} className={`tabbtn${ch === c ? " on" : ""}`} onClick={() => pick(i, s, c)}>
                    {c === "ours" ? "Use ours" : c === "theirs" ? "Use theirs" : c === "both" ? "Use both" : "Edit by hand"}
                  </button>
                ))}
              </div>
              {ch === "custom" && (
                <textarea className="merge-edit" spellCheck={false} rows={Math.min(18, Math.max(3, (custom[i] ?? "").split("\n").length + 1))}
                  value={(custom[i] ?? "").replace(/\r/g, "")} onChange={(e) => setCustom((o) => ({ ...o, [i]: e.target.value }))} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
