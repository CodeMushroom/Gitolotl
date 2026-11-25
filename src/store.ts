import { create } from "zustand";
import { api } from "./api";
import type { Backup, Commit, CommitDetails, DiffKind, GithubInfo, PullRequest, RefInfo, Remote, RepoInfo, Stash, Status, Worktree } from "./api";

export type Vision = "default" | "redgreen" | "blueyellow" | "contrast";
export interface Prefs { vision: Vision; pictures: "initials" | "online" }
const applyPrefs = (p: Prefs) => { document.documentElement.dataset.vision = p.vision; };

export type Selection = { type: "wip" } | { type: "commit"; hash: string } | null;
export interface OpenFile { kind: DiffKind; path: string; hash?: string; oldPath?: string | null; view: "diff" | "blame" | "history" | "merge" }
export interface Toast { id: number; kind: "ok" | "err"; text: string }
export interface Field {
  key: string; label: string; type: "text" | "textarea" | "checkbox" | "select" | "folder";
  value?: string | boolean; options?: [string, string][]; placeholder?: string;
}
export type Values = Record<string, string | boolean>;
export interface FormModal {
  kind: "form"; title: string; message?: string; fields?: Field[]; confirm?: string; danger?: boolean;
  /** an optional second way forward, shown next to Cancel */
  alt?: { label: string; onClick: () => void };
  /** called when a field changes (with the values before the change); may return other fields to set */
  onChange?: (key: string, value: string | boolean, before: Values) => Partial<Values> | void;
  onSubmit: (v: Values) => void | Promise<void>;
}
export type Modal = FormModal | { kind: "irebase"; from: string } | { kind: "worktrees" } | null;
export interface MenuItem { label?: string; onClick?: () => void; danger?: boolean; sep?: boolean; disabled?: boolean }
export interface Menu { x: number; y: number; items: MenuItem[] }

const load = <T,>(k: string, d: T): T => {
  try { return JSON.parse(localStorage.getItem(k) ?? "") as T; } catch { return d; }
};
const save = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } };

/** Widths the user can drag, in pixels. `graph` caps the lane column; null shows every lane. */
export interface Layout { sidebar: number; panel: number; refs: number; author: number; date: number; graph: number | null }
export const LAYOUT: Layout = { sidebar: 250, panel: 380, refs: 190, author: 150, date: 86, graph: null };
const applyLayout = (l: Layout) => {
  const s = document.documentElement.style;
  s.setProperty("--sb-w", `${l.sidebar}px`);
  s.setProperty("--panel-w", `${l.panel}px`);
  s.setProperty("--col-refs", `${l.refs}px`);
  s.setProperty("--col-author", `${l.author}px`);
  s.setProperty("--col-date", `${l.date}px`);
};

interface State {
  layout: Layout;
  setLayout: (p: Partial<Layout>) => void;
  repo: RepoInfo | null;
  tabs: RepoInfo[];
  recent: RepoInfo[];
  status: Status | null;
  commits: Commit[];
  refs: RefInfo[];
  /** origin's default branch, e.g. "origin/main"; null when unknown */
  defaultBranch: string | null;
  remotes: Remote[];
  stashes: Stash[];
  worktrees: Worktree[];
  backups: Backup[];
  aiOnly: boolean;
  /** version of an update that is ready to install, if any */
  update: string | null;
  /** commits the user has marked as reviewed, per repository (kept on this machine) */
  reviewed: Record<string, true>;
  prefs: Prefs;
  setPrefs: (p: Partial<Prefs>) => void;
  /** pictures the user chose for people, keyed by lower-cased email (data URLs, this machine only) */
  faces: Record<string, string>;
  setFace: (email: string, dataUrl: string | null) => void;
  toggleReviewed: (hash: string) => void;
  palette: boolean;
  gh: GithubInfo | null;
  prs: PullRequest[];
  selected: Selection;
  details: CommitDetails | null;
  openFile: OpenFile | null;
  scrollTo: string | null;
  limit: number;
  showAll: boolean;
  search: string;
  busy: string | null;
  toasts: Toast[];
  modal: Modal;
  menu: Menu | null;

  openRepo: (path: string) => Promise<void>;
  adoptRepo: (info: RepoInfo) => Promise<void>;
  closeTab: (path: string) => void;
  goHome: () => void;
  refresh: () => Promise<void>;
  refreshStatus: () => Promise<void>;
  loadGithub: (interactive?: boolean) => Promise<void>;
  act: (label: string, fn: (repo: string) => Promise<unknown>, quiet?: boolean) => Promise<boolean>;
  select: (s: Selection, scroll?: boolean) => void;
  setOpenFile: (f: OpenFile | null) => void;
  toast: (kind: Toast["kind"], text: string) => void;
  dismissToast: (id: number) => void;
  set: (p: Partial<State>) => void;
}

let toastId = 1;

export const useStore = create<State>((set, get) => ({
  layout: (() => { const l = { ...LAYOUT, ...load<Partial<Layout>>("gitolotl.layout", {}) }; applyLayout(l); return l; })(),
  setLayout: (p) => {
    const layout = { ...get().layout, ...p };
    save("gitolotl.layout", layout);
    applyLayout(layout);
    set({ layout });
  },
  repo: null,
  tabs: load<RepoInfo[]>("gitolotl.tabs", []),
  recent: load<RepoInfo[]>("gitolotl.recent", []),
  status: null,
  commits: [],
  refs: [],
  defaultBranch: null,
  remotes: [],
  stashes: [],
  worktrees: [],
  backups: [],
  aiOnly: false,
  update: null,
  reviewed: {},
  prefs: (() => { const p = { vision: "default", pictures: "initials", ...load<Partial<Prefs>>("gitolotl.prefs", {}) } as Prefs; applyPrefs(p); return p; })(),
  setPrefs: (p) => {
    const prefs = { ...get().prefs, ...p };
    save("gitolotl.prefs", prefs);
    applyPrefs(prefs);
    set({ prefs });
  },
  faces: load<Record<string, string>>("gitolotl.faces", {}),
  setFace: (email, dataUrl) => {
    const faces = { ...get().faces };
    const key = email.trim().toLowerCase();
    if (dataUrl) faces[key] = dataUrl;
    else delete faces[key];
    save("gitolotl.faces", faces);
    set({ faces });
  },
  toggleReviewed: (hash) => {
    const repo = get().repo?.path;
    if (!repo) return;
    const reviewed = { ...get().reviewed };
    if (reviewed[hash]) delete reviewed[hash];
    else reviewed[hash] = true;
    save(`gitolotl.reviewed:${repo}`, reviewed);
    set({ reviewed });
  },
  palette: false,
  gh: null,
  prs: [],
  selected: null,
  details: null,
  openFile: null,
  scrollTo: null,
  limit: 3000,
  showAll: true,
  search: "",
  busy: null,
  toasts: [],
  modal: null,
  menu: null,

  set: (p) => set(p),

  openRepo: async (path) => {
    try {
      await get().adoptRepo(await api.repoOpen(path));
    } catch (e) {
      get().toast("err", String(e));
      const recent = get().recent.filter((r) => r.path !== path);
      const tabs = get().tabs.filter((r) => r.path !== path);
      save("gitolotl.recent", recent);
      save("gitolotl.tabs", tabs);
      set({ recent, tabs });
    }
  },

  adoptRepo: async (info) => {
    const tabs = get().tabs.some((t) => t.path === info.path) ? get().tabs : [...get().tabs, info];
    const recent = [info, ...get().recent.filter((r) => r.path !== info.path)].slice(0, 12);
    save("gitolotl.tabs", tabs);
    save("gitolotl.recent", recent);
    save("gitolotl.active", info.path);
    set({
      repo: info, tabs, recent, status: null, commits: [], refs: [], remotes: [], stashes: [], gh: null, prs: [],
      selected: null, details: null, openFile: null, search: "", limit: 3000,
      reviewed: load<Record<string, true>>(`gitolotl.reviewed:${info.path}`, {}),
    });
    await get().refresh();
    void get().loadGithub(false);
  },

  closeTab: (path) => {
    const tabs = get().tabs.filter((t) => t.path !== path);
    save("gitolotl.tabs", tabs);
    set({ tabs });
    if (get().repo?.path === path) {
      if (tabs.length) void get().openRepo(tabs[tabs.length - 1].path);
      else get().goHome();
    }
  },

  goHome: () => {
    save("gitolotl.active", "");
    set({ repo: null, status: null, commits: [], selected: null, details: null, openFile: null });
  },

  refresh: async () => {
    const repo = get().repo?.path;
    if (!repo) return;
    try {
      const { limit, showAll } = get();
      const [status, commits, refs, remotes, stashes, worktrees, backups, defaultBranch] = await Promise.all([
        api.status(repo), api.log(repo, limit, showAll), api.refs(repo), api.remotes(repo), api.stashes(repo),
        api.worktrees(repo).catch(() => []),
        api.backups(repo).catch(() => []),
        api.defaultBranch(repo).catch(() => null),
      ]);
      if (get().repo?.path !== repo) return;
      set({ status, commits, refs, remotes, stashes, worktrees, backups, defaultBranch });
      const sel = get().selected;
      if (sel?.type === "wip" && status.files.length === 0 && !status.state) set({ selected: null, openFile: null });
    } catch (e) {
      if (!lost(repo, e)) get().toast("err", String(e));
    }
  },

  refreshStatus: async () => {
    const repo = get().repo?.path;
    if (!repo || get().busy) return;
    try {
      const status = await api.status(repo);
      if (get().repo?.path !== repo) return;
      const prev = get().status;
      if (JSON.stringify(prev) === JSON.stringify(status)) return;
      if (prev && (prev.head !== status.head || prev.branch !== status.branch)) await get().refresh();
      else set({ status });
    } catch (e) { lost(repo, e); /* anything else is transient */ }
  },

  loadGithub: async (interactive = false) => {
    const repo = get().repo?.path;
    if (!repo) return;
    try {
      const gh = await api.githubInfo(repo, interactive);
      if (get().repo?.path !== repo) return;
      set({ gh });
      const prs = await api.githubPrs(repo);
      if (get().repo?.path === repo) set({ prs });
    } catch (e) {
      if (get().repo?.path === repo) set({ prs: [] });
      if (interactive) get().toast("err", String(e));
    }
  },

  act: async (label, fn, quiet) => {
    const repo = get().repo?.path;
    if (!repo || get().busy) return false;
    set({ busy: label });
    let ok = true;
    try {
      const out = await fn(repo);
      if (!quiet) get().toast("ok", typeof out === "string" && out.trim() ? `${label}\n${out.trim()}` : label);
    } catch (e) {
      ok = false;
      if (!lost(repo, e)) get().toast("err", `${label} failed\n${String(e)}`);
    }
    set({ busy: null });
    await get().refresh();
    return ok;
  },

  select: (s, scroll) => {
    set({ selected: s, openFile: null, details: null, scrollTo: scroll && s?.type === "commit" ? s.hash : null });
    const repo = get().repo?.path;
    if (s?.type === "commit" && repo) {
      api.details(repo, s.hash).then((d) => {
        const cur = get().selected;
        if (cur?.type === "commit" && cur.hash === s.hash) set({ details: d });
      }).catch((e) => get().toast("err", String(e)));
    }
  },

  setOpenFile: (f) => set({ openFile: f }),

  toast: (kind, text) => {
    const id = toastId++;
    const t = text.length > 1200 ? text.slice(0, 1200) + "…" : text;
    set({ toasts: [...get().toasts.slice(-4), { id, kind, text: t }] });
    if (kind === "ok") setTimeout(() => get().dismissToast(id), 4500);
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));

export const st = () => useStore.getState();
export const fmtDate = (t: number) => {
  const d = new Date(t * 1000);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
};
export const fullDate = (t: number) => new Date(t * 1000).toLocaleString();

/**
 * The open repository's folder is gone: a worktree that was removed, or a folder that was
 * deleted or moved. Say so once and close its tab, instead of failing on every refresh.
 */
function lost(path: string, e: unknown): boolean {
  if (!String(e).includes(`Not a directory: ${path}`)) return false;
  const s = useStore.getState();
  if (s.repo?.path !== path) return true;
  const recent = s.recent.filter((r) => r.path !== path);
  save("gitolotl.recent", recent);
  s.set({ recent });
  s.toast("err", `${path} no longer exists, so its tab was closed.\nIt may have been a worktree that was removed, or the folder was moved or deleted.`);
  s.closeTab(path);
  return true;
}
