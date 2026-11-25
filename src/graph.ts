import type { Commit } from "./api";

/** [laneIndex, colorIndex] */
export type Edge = [number, number];

export interface GraphRow {
  col: number;
  color: number;
  /** lanes passing straight through this row */
  through: Edge[];
  /** lanes arriving from the row above into this commit's node */
  ins: Edge[];
  /** edges leaving the node towards parents in rows below */
  outs: Edge[];
  merge: boolean;
}

export interface GraphLayout { rows: GraphRow[]; maxCols: number }

/** Assigns each commit (already in display order) to a lane and computes the edges per row. */
export function layoutGraph(commits: Commit[]): GraphLayout {
  const lanes: (string | null)[] = [];
  const colors: number[] = [];
  let nextColor = 0;
  let maxCols = 1;
  const free = () => {
    const i = lanes.indexOf(null);
    if (i !== -1) return i;
    lanes.push(null);
    return lanes.length - 1;
  };

  const rows: GraphRow[] = commits.map((c) => {
    const ins: Edge[] = [];
    const through: Edge[] = [];
    let col = -1;
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i] === c.hash) {
        if (col === -1) col = i;
        ins.push([i, colors[i]]);
      } else if (lanes[i] !== null) {
        through.push([i, colors[i]]);
      }
    }
    if (col === -1) {
      col = free();
      colors[col] = nextColor++;
    }
    const color = colors[col];
    for (const [i] of ins) lanes[i] = null;
    lanes[col] = null;

    const outs: Edge[] = [];
    c.parents.forEach((p, idx) => {
      // A commit's own line (to its first parent) keeps its lane and colour all the way down to
      // that parent, even when another line is already heading there. The lines then meet at
      // the parent's node, so where a branch started is a commit you can see, not a point
      // somewhere along a neighbour's line. A merged-in parent joins a line already going there.
      let j = idx === 0 ? -1 : lanes.indexOf(p);
      if (j === -1) {
        if (idx === 0) {
          j = col;
          colors[j] = color;
        } else {
          j = free();
          colors[j] = nextColor++;
        }
        lanes[j] = p;
      }
      outs.push([j, colors[j]]);
    });
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    maxCols = Math.max(maxCols, lanes.length, col + 1);
    return { col, color, through, ins, outs, merge: c.parents.length > 1 };
  });
  return { rows, maxCols };
}

/** Lane colours are CSS variables (--lane-0 … --lane-7) so colour-vision presets can swap the palette. */
export const laneColor = (i: number) => `var(--lane-${i % 8})`;
