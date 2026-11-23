import type React from "react";
import { LAYOUT, st } from "../store";
import type { Layout } from "../store";

/**
 * A draggable divider that resizes one entry of the saved layout.
 * `grow` is 1 when dragging right makes it wider, -1 when dragging left does.
 * `base` is the starting width for an entry that has no saved value yet.
 */
export function Splitter({ k, grow, min, max, base, className = "" }: { k: keyof Layout; grow: 1 | -1; min: number; max: number; base?: number; className?: string }) {
  const down = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const start = st().layout[k] ?? base ?? min;
    const x0 = e.clientX;
    const move = (m: MouseEvent) => st().setLayout({ [k]: Math.round(Math.max(min, Math.min(max, start + grow * (m.clientX - x0)))) });
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.classList.remove("resizing");
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    document.body.classList.add("resizing");
  };
  return (
    <div
      className={`split ${className}`}
      title="Drag to resize. Double-click to reset."
      onMouseDown={down}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => { e.stopPropagation(); st().setLayout({ [k]: LAYOUT[k] }); }}
    />
  );
}
