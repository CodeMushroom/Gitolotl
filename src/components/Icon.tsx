import { useEffect, useState } from "react";
import type React from "react";
import type { ReactNode } from "react";
import { onlinePicture, pickPicture } from "../faces";
import { st, useStore } from "../store";

const PATHS: Record<string, ReactNode> = {
  fetch: <><path d="M20 12a8 8 0 1 1-2.4-5.7" /><path d="M20 3.5V9h-5.5" /></>,
  pull: <><path d="M12 3.5v12" /><path d="M6.5 10.5l5.5 5.5 5.5-5.5" /><path d="M5 20.5h14" /></>,
  push: <><path d="M12 20.5v-12" /><path d="M6.5 13.5L12 8l5.5 5.5" /><path d="M5 3.5h14" /></>,
  branch: <><circle cx="6" cy="5" r="2.2" /><circle cx="6" cy="19" r="2.2" /><circle cx="18" cy="8" r="2.2" /><path d="M6 7.2v9.6" /><path d="M18 10.2c0 4.5-12 2-12 6.6" /></>,
  stash: <><path d="M4 13l2.5-8h11L20 13" /><path d="M4 13v6h16v-6" /><path d="M4 13h5a3 3 0 0 0 6 0h5" /></>,
  pop: <><path d="M4 14v5h16v-5" /><path d="M12 15V4" /><path d="M8 8l4-4 4 4" /></>,
  pr: <><circle cx="6" cy="6" r="2.2" /><circle cx="6" cy="18" r="2.2" /><circle cx="18" cy="18" r="2.2" /><path d="M6 8.2v7.6" /><path d="M18 15.8V10a4 4 0 0 0-4-4h-3" /><path d="M13 3.5L10.5 6 13 8.5" /></>,
  settings: <><circle cx="12" cy="12" r="3.2" /><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1" /></>,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="M16 16l4.5 4.5" /></>,
  shield: <><path d="M12 3l7.5 3v5.5c0 4.5-3 8-7.5 9.5-4.5-1.500-7.5-5-7.5-9.500V6z" /><path d="M9 12l2.2 2.200L15.200 10" /></>,
};

export function Icon({ name, size = 18 }: { name: keyof typeof PATHS | string; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {PATHS[name]}
    </svg>
  );
}

/** Stable colour for a person, derived from their email. */
export const personHue = (email: string) => [...email].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);

export function Avatar({ name, email, size = 18, editable }: { name: string; email: string; size?: number; editable?: boolean }) {
  const key = email.trim().toLowerCase();
  const custom = useStore((s) => s.faces[key]);
  const online = useStore((s) => s.prefs.pictures === "online");
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setUrl(null);
    if (!custom && online) void onlinePicture(email, size).then((u) => live && setUrl(u));
    return () => { live = false; };
  }, [custom, online, email, size]);

  const h = personHue(email || name);
  const src = custom ?? url;
  const menu = editable
    ? (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        st().set({ menu: { x: e.clientX, y: e.clientY, items: [
          { label: `Set picture for ${name}…`, onClick: () => void pickPicture().then((d) => d && st().setFace(email, d)) },
          { label: "Remove picture", disabled: !custom, onClick: () => st().setFace(email, null) },
        ] } });
      }
    : undefined;
  return (
    <span
      className={`avatar-s${editable ? " editable" : ""}`}
      title={editable ? "Click to set a picture for this person" : undefined}
      onClick={menu}
      onContextMenu={menu}
      style={{ width: size, height: size, fontSize: size * 0.55, background: `linear-gradient(135deg, hsl(${h} 65% 55%), hsl(${(h + 40) % 360} 60% 40%))` }}
    >
      {(name.trim()[0] ?? "?").toUpperCase()}
      {src && <img src={src} alt="" width={size} height={size} referrerPolicy="no-referrer" onError={() => setUrl(null)} />}
    </span>
  );
}
