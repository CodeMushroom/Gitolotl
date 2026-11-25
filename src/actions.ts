import { open } from "@tauri-apps/plugin-dialog";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import type { Update } from "@tauri-apps/plugin-updater";
import type React from "react";
import { api } from "./api";
import type { Backup, Commit, FileStatus, PullRequest, RefInfo, Stash } from "./api";
import { st } from "./store";
import { aiAgent } from "./ai";
import { defaultName, primaryFirst } from "./branches";
import type { Field, FormModal, MenuItem, Vision } from "./store";

let pendingUpdate: Update | null = null;
const loadPrompt = (): { version: string; at: number } => {
  try { return { version: "", at: 0, ...JSON.parse(localStorage.getItem("gitolotl.updatePrompt") ?? "{}") }; } catch { return { version: "", at: 0 }; }
};

const LABELS: Record<string, string> = {
  discard: "discard", "discard-hunk": "discarded lines", "reset-hard": "hard reset", reset: "reset", amend: "amend",
  rebase: "rebase", "interactive-rebase": "interactive rebase", abort: "abort", "rebase-skip": "skipped commit",
  "resolve-conflict": "conflict resolution", "merge-edit": "merge edit", "delete-branch": "deleted branch",
  "delete-remote-branch": "deleted remote branch", "delete-tag": "deleted tag", "drop-stash": "dropped stash",
  undo: "undo", "undo-move": "undo", manual: "manual snapshot",
};
const UNDO_EFFECT: Record<string, string> = {
  discard: "Puts the discarded files back.", "discard-hunk": "Puts the discarded lines back.",
  "reset-hard": "Moves the branch back and restores your uncommitted files.", reset: "Moves the branch back to where it was.",
  amend: "Moves the branch back to the commit before the amend; the amended changes stay staged.",
  rebase: "Moves the branch back to where it was before the rebase.", "interactive-rebase": "Moves the branch back to where it was before the rebase.",
  abort: "Restores the files as they were before the abort.", "delete-branch": "Recreates the branch.",
  "delete-remote-branch": "Recreates it as a local branch, ready to push.", "delete-tag": "Recreates the tag.", "drop-stash": "Puts the stash back.",
};
export const describe = (b: Backup) => `${LABELS[b.label] ?? b.label}${b.detail && /^delete-/.test(b.label) ? ` ${b.detail}` : ""}`;

const form = (m: Omit<FormModal, "kind">) => st().set({ modal: { kind: "form", ...m } });
const s = (v: string | boolean | undefined) => String(v ?? "").trim();
const short = (h: string) => h.slice(0, 7);
const copy = (text: string) => navigator.clipboard.writeText(text).then(() => st().toast("ok", "Copied to clipboard"), () => {});

export const pickFolder = async (): Promise<string | null> => {
  const r = await open({ directory: true, multiple: false });
  return typeof r === "string" ? r : null;
};

export const openExternal = (url: string) => {
  // Defence in depth: the Tauri capability also restricts this to github.com.
  if (url.startsWith("https://github.com/")) void openUrl(url).catch((e) => st().toast("err", String(e)));
};

export const A = {
  /**
   * Looks for a newer signed release. A manual check always reports back. The
   * background check (on launch and every few hours) only lights up the
   * "Update" button, and opens the prompt at most once a day per version.
   * Nothing is downloaded or installed until the user confirms.
   */
  checkForUpdates: async (manual = false) => {
    try {
      pendingUpdate = await check();
      if (!pendingUpdate) {
        st().set({ update: null });
        if (manual) st().toast("ok", `Gitolotl ${await getVersion()} is up to date.`);
        return;
      }
      st().set({ update: pendingUpdate.version });
      const seen = loadPrompt();
      const due = seen.version !== pendingUpdate.version || Date.now() - seen.at > 24 * 3600 * 1000;
      if (manual || (due && !st().modal && !st().busy)) A.promptUpdate();
    } catch (e) {
      if (!manual) return;
      const msg = String(e);
      st().toast("err", /platforms/.test(msg)
        ? "A new version is being published right now and is not ready for this computer yet. Try again in a few minutes."
        : `Could not check for updates\n${msg}`);
    }
  },
  promptUpdate: () => {
    const update = pendingUpdate;
    if (!update) return void A.checkForUpdates(true);
    try { localStorage.setItem("gitolotl.updatePrompt", JSON.stringify({ version: update.version, at: Date.now() })); } catch { /* ignore */ }
    form({
      title: `Update available: Gitolotl ${update.version}`,
      message: `You have ${update.currentVersion}.\n\n${(update.body ?? "").split("## Download")[0].replace(/^## .*$/m, "").trim().slice(0, 900)}`.trim(),
      confirm: "Install and restart",
      alt: { label: "Remind me tomorrow", onClick: () => st().set({ modal: null }) },
      onSubmit: async () => {
        st().set({ busy: `Downloading Gitolotl ${update.version}…` });
        try {
          await update.downloadAndInstall();
          await relaunch();
        } finally {
          st().set({ busy: null });
        }
      },
    });
  },

  /** Copies a patch as a fenced block, ready to paste into an AI chat. */
  copyForAi: async (kind: "worktree" | "staged" | "commit", hash?: string) => {
    const repo = st().repo?.path;
    if (!repo) return;
    try {
      const d = await api.patch(repo, kind, hash);
      if (!d.text.trim()) return void st().toast("err", "Nothing to copy: the diff is empty.");
      const c = hash ? st().commits.find((x) => x.hash === hash) : undefined;
      const head = kind === "commit" ? `Commit ${hash?.slice(0, 10)}${c ? `: ${c.subject}` : ""}` : kind === "staged" ? "Staged changes" : "Unstaged changes";
      const fence = "`".repeat(3);
      await navigator.clipboard.writeText(`${head}\n\n${fence}diff\n${d.text}${d.truncated ? "\n[truncated]\n" : ""}${fence}\n`);
      st().toast("ok", `Copied ${d.text.split("\n").length.toLocaleString()} diff lines for AI`);
    } catch (e) {
      st().toast("err", String(e));
    }
  },
  reviewAll: (kind: "worktree" | "staged" | "commit", hash?: string) => st().setOpenFile({ kind, path: "*", hash, view: "diff" }),

  openDialog: async () => {
    const p = await pickFolder();
    if (p) await st().openRepo(p);
  },
  init: async () => {
    const p = await pickFolder();
    if (!p) return;
    try { await st().adoptRepo(await api.repoInit(p)); } catch (e) { st().toast("err", String(e)); }
  },
  clone: () =>
    form({
      title: "Clone repository",
      fields: [
        { key: "url", label: "Repository URL", type: "text", placeholder: "https://github.com/owner/repo.git" },
        { key: "parent", label: "Clone into folder", type: "folder" },
        { key: "name", label: "Folder name (optional)", type: "text" },
      ],
      confirm: "Clone",
      onSubmit: async (v) => {
        const url = s(v.url);
        const parent = s(v.parent);
        if (!url || !parent) throw new Error("URL and destination folder are required");
        const name = s(v.name) || (url.replace(/[\\/]+$/, "").split(/[\\/:]/).pop() ?? "").replace(/\.git$/, "");
        st().set({ busy: "Cloning…" });
        try {
          await st().adoptRepo(await api.repoClone(url, parent, name));
        } finally {
          st().set({ busy: null });
        }
      },
    }),

  fetch: () => st().act("Fetch", (r) => api.fetch(r)),
  pull: (mode = "merge") => st().act(`Pull (${mode})`, (r) => api.pull(r, mode)),
  push: async (force = false, reviewedOk = false): Promise<void> => {
    const { status, remotes, repo } = st();
    if (!status?.branch) return void st().toast("err", "Cannot push a detached HEAD. Create a branch first.");
    if (!remotes.length) return A.addRemote();
    const branch = status.branch;
    // Review gate: AI-written commits you have not marked as reviewed.
    if (!reviewedOk && repo) {
      const hashes = await api.unpushed(repo.path).catch(() => [] as string[]);
      const { commits, reviewed } = st();
      const pending = hashes.map((h) => commits.find((c) => c.hash === h)).filter((c): c is Commit => !!c && !!aiAgent(c) && !reviewed[c.hash]);
      if (pending.length) {
        return form({
          title: `${pending.length} AI-assisted commit${pending.length === 1 ? "" : "s"} not marked as reviewed`,
          message: pending.slice(0, 6).map((c) => `• ${c.subject}`).join("\n") + (pending.length > 6 ? `\n…and ${pending.length - 6} more` : ""),
          confirm: "Push anyway",
          alt: { label: "Review them", onClick: () => { st().set({ modal: null }); st().select({ type: "commit", hash: pending[pending.length - 1].hash }, true); A.reviewAll("commit", pending[pending.length - 1].hash); } },
          onSubmit: () => A.push(force, true),
        });
      }
    }
    if (!status.upstream) {
      const remote = remotes.find((r) => r.name === "origin")?.name ?? remotes[0].name;
      return void st().act(`Push ${branch} → ${remote}`, (r) => api.push(r, { remote, branch, setUpstream: true, force }));
    }
    return void st().act(force ? "Force push (with lease)" : "Push", (r) => api.push(r, { force }));
  },
  forcePush: () =>
    form({
      title: "Force push?",
      message: "This rewrites the remote branch. Gitolotl uses --force-with-lease, so it is refused if someone else pushed in the meantime.",
      confirm: "Force push",
      danger: true,
      onSubmit: () => A.push(true),
    }),

  /** Ctrl+Z: put back whatever the most recent destructive action removed. */
  undo: () => {
    const b = st().backups[0];
    if (!b) return void st().toast("ok", "Nothing to undo.");
    A.restore(b);
  },
  restore: (b: Backup) =>
    form({
      title: `Undo ${describe(b)}?`,
      message: `${UNDO_EFFECT[b.label] ?? "Restores what this snapshot saved."} Your current state is snapshotted first, so this can itself be undone.`,
      confirm: "Undo",
      onSubmit: async () => { st().setOpenFile(null); await st().act(`Undo ${describe(b)}`, (r) => api.restoreBackup(r, b.name)); },
    }),
  worktrees: () => st().set({ modal: { kind: "worktrees" } }),

  /** With `start` the starting point is fixed ("Create branch here"); without, the dialog asks. */
  newBranch: async (start?: string) => {
    const { repo, status, refs } = st();
    if (!repo) return;
    const cur = status?.branch ?? null;
    const fields: Field[] = [{ key: "name", label: "Branch name", type: "text", placeholder: "feature/my-branch" }];

    if (!start) {
      const heads = refs.filter((r) => r.kind === "head");
      const remotes = refs.filter((r) => r.kind === "remote" && !r.short.endsWith("/HEAD"));
      // The default branch: what origin says, else the usual names.
      const remoteDefault = await api.defaultBranch(repo.path).catch(() => null);
      // The default branch: what origin says, else the first conventional name that exists.
      const byName = primaryFirst(heads, (h) => h.short, remoteDefault);
      const def = remoteDefault ? heads.find((h) => h.short === defaultName(remoteDefault)) : byName.pinned[0];
      const opts: [string, string][] = [];
      const add = (value: string, label: string) => { if (!opts.some((o) => o[0] === value)) opts.push([value, label]); };
      const behind = def?.behind ? `, ${def.behind} behind ${def.upstream}` : "";
      // A stale local default branch is the classic way to start from old code: offer the remote copy too.
      const fresher = () => { if (def?.behind && def.upstream) add(def.upstream, `${def.upstream} · default branch as last fetched`); };
      if (def && def.short === cur) {
        add("", `${cur} · current and default branch${behind}`);
        fresher();
      } else if (def) {
        // Like GitHub Desktop: new work normally starts from the default branch.
        add(def.short, `${def.short} · default branch${behind}`);
        fresher();
      } else if (remoteDefault) {
        add(remoteDefault, `${remoteDefault} · default branch`);
      }
      add("", cur ? `${cur} · current branch` : `${short(status?.head ?? "")} · current commit`);
      for (const h of [...byName.pinned, ...byName.rest]) if (h.short !== cur) add(h.short, h.short);
      for (const r of remotes) add(r.short, r.short);
      fields.push({ key: "start", label: "Start from", type: "select", value: opts[0][0], options: opts });
    }

    fields.push({ key: "checkout", label: "Check out after creating", type: "checkbox", value: true });
    const dirty = status?.files.length ?? 0;
    if (dirty) {
      fields.push({
        key: "changes", type: "select", value: "bring",
        label: `Your ${dirty} uncommitted ${dirty === 1 ? "change" : "changes"}`,
        options: [
          ["bring", "Bring them to the new branch"],
          ["leave", `Leave them on ${cur ?? "the current commit"} (stashed)`],
        ],
      });
    }

    form({
      title: start ? `Create branch at ${start.length === 40 ? short(start) : start}` : "Create branch",
      fields,
      confirm: "Create",
      onSubmit: async (v) => {
        const name = s(v.name);
        if (!name) throw new Error("Branch name is required");
        const from = start ?? (s(v.start) || undefined);
        const changes = v.changes === "leave" ? "leave" : "bring";
        // Errors stay in the dialog so a different choice can be made without retyping.
        const repoPath = st().repo?.path;
        if (!repoPath) return;
        st().set({ busy: `Create branch ${name}` });
        try {
          const msg = await api.createBranch(repoPath, name, from, !!v.checkout, changes);
          st().toast("ok", `Created branch ${name}${msg.includes("stayed behind") ? `\nYour uncommitted changes stayed on ${cur ?? "the previous commit"} as a stash.` : ""}`);
        } finally {
          st().set({ busy: null });
          await st().refresh();
        }
      },
    });
  },
  checkout: (target: string, kind: "head" | "remote" | "tag" | "commit") => {
    // git allows a branch in one worktree at a time: offer to go to where it already is.
    const name = kind === "remote" ? target.slice(target.indexOf("/") + 1) : target;
    const wt = kind === "head" || kind === "remote" ? st().worktrees.find((w) => !w.current && w.branch === name) : undefined;
    if (wt) {
      return form({
        title: `${name} is open in another worktree`,
        message: `${wt.path}\n\nA branch can be checked out in only one worktree at a time, so it cannot be checked out here as well. Open that worktree to work on ${name}.`,
        confirm: "Open that worktree",
        onSubmit: () => st().openRepo(wt.path),
      });
    }
    return void st().act(`Checkout ${kind === "commit" ? short(target) : target}`, (r) => api.checkout(r, target, kind), true);
  },
  renameBranch: (name: string) =>
    form({
      title: `Rename ${name}`,
      fields: [{ key: "name", label: "New name", type: "text", value: name }],
      confirm: "Rename",
      onSubmit: async (v) => { await st().act("Rename branch", (r) => api.renameBranch(r, name, s(v.name)), true); },
    }),
  deleteBranch: (ref: RefInfo) =>
    form({
      title: `Delete ${ref.short}?`,
      message: ref.kind === "remote" ? "This deletes the branch on the remote for everyone." : undefined,
      fields: ref.kind === "head" ? [{ key: "force", label: "Force delete even if unmerged", type: "checkbox", value: false }] : [],
      confirm: "Delete",
      danger: true,
      onSubmit: async (v) => {
        if (ref.kind === "remote") {
          const i = ref.short.indexOf("/");
          await st().act(`Delete ${ref.short}`, (r) => api.deleteRemoteBranch(r, ref.short.slice(0, i), ref.short.slice(i + 1)));
        } else {
          await st().act(`Delete ${ref.short}`, (r) => api.deleteBranch(r, ref.short, !!v.force), true);
        }
      },
    }),
  merge: (target: string) =>
    form({
      title: `Merge ${target} into ${st().status?.branch ?? "HEAD"}`,
      fields: [{
        key: "mode", label: "Strategy", type: "select", value: "ff",
        options: [["ff", "Fast-forward if possible"], ["no-ff", "Always create a merge commit"], ["ff-only", "Fast-forward only"], ["squash", "Squash (stage changes, no commit)"]],
      }],
      confirm: "Merge",
      onSubmit: async (v) => { await st().act(`Merge ${target}`, (r) => api.merge(r, target, s(v.mode))); },
    }),
  rebase: (onto: string) =>
    form({
      title: `Rebase ${st().status?.branch ?? "HEAD"} onto ${onto.length === 40 ? short(onto) : onto}?`,
      message: "Rebasing rewrites the commits on your current branch.",
      confirm: "Rebase",
      onSubmit: async () => { await st().act("Rebase", (r) => api.rebase(r, onto)); },
    }),
  cherryPick: (hash: string) => st().act(`Cherry-pick ${short(hash)}`, (r) => api.cherryPick(r, hash)),
  revert: (hash: string) => st().act(`Revert ${short(hash)}`, (r) => api.revert(r, hash)),
  reset: (hash: string) =>
    form({
      title: `Reset ${st().status?.branch ?? "HEAD"} to ${short(hash)}`,
      fields: [{
        key: "mode", label: "Mode", type: "select", value: "mixed",
        options: [["soft", "Soft — keep changes staged"], ["mixed", "Mixed — keep changes unstaged"], ["hard", "Hard — DISCARD all changes"]],
      }],
      confirm: "Reset",
      danger: true,
      onSubmit: async (v) => { await st().act(`Reset to ${short(hash)}`, (r) => api.reset(r, hash, s(v.mode)), true); },
    }),
  irebase: (from: string) => st().set({ modal: { kind: "irebase", from } }),

  newTag: (target?: string) =>
    form({
      title: target ? `Create tag at ${short(target)}` : "Create tag",
      fields: [
        { key: "name", label: "Tag name", type: "text", placeholder: "v1.0.0" },
        { key: "message", label: "Message (makes an annotated tag)", type: "textarea" },
      ],
      confirm: "Create tag",
      onSubmit: async (v) => {
        if (!s(v.name)) throw new Error("Tag name is required");
        await st().act(`Create tag ${s(v.name)}`, (r) => api.createTag(r, s(v.name), target, s(v.message)), true);
      },
    }),
  deleteTag: (name: string) =>
    form({ title: `Delete tag ${name}?`, confirm: "Delete", danger: true, onSubmit: async () => { await st().act(`Delete tag ${name}`, (r) => api.deleteTag(r, name), true); } }),
  pushTag: (name: string) => {
    const remote = st().remotes.find((r) => r.name === "origin")?.name ?? st().remotes[0]?.name;
    if (!remote) return A.addRemote();
    return void st().act(`Push tag ${name}`, (r) => api.push(r, { remote, branch: `refs/tags/${name}` }));
  },

  stash: () =>
    form({
      title: "Stash changes",
      fields: [
        { key: "message", label: "Message (optional)", type: "text" },
        { key: "untracked", label: "Include untracked files", type: "checkbox", value: true },
      ],
      confirm: "Stash",
      onSubmit: async (v) => { await st().act("Stash", (r) => api.stashPush(r, s(v.message), !!v.untracked), true); },
    }),
  stashOp: (op: "apply" | "pop" | "drop", index: number) => {
    const go = () => st().act(`Stash ${op}`, (r) => api.stashOp(r, op, index), true);
    if (op !== "drop") return void go();
    form({ title: "Drop this stash?", message: "Ctrl+Z brings it back.", confirm: "Drop", danger: true, onSubmit: async () => { await go(); } });
  },

  addRemote: () =>
    form({
      title: "Add remote",
      fields: [
        { key: "name", label: "Name", type: "text", value: st().remotes.length ? "" : "origin" },
        { key: "url", label: "URL", type: "text", placeholder: "https://github.com/owner/repo.git" },
      ],
      confirm: "Add remote",
      onSubmit: async (v) => {
        const ok = await st().act(`Add remote ${s(v.name)}`, (r) => api.addRemote(r, s(v.name), s(v.url)), true);
        if (ok) void st().loadGithub(false);
      },
    }),
  removeRemote: (name: string) =>
    form({ title: `Remove remote ${name}?`, confirm: "Remove", danger: true, onSubmit: async () => { await st().act(`Remove remote ${name}`, (r) => api.removeRemote(r, name), true); } }),

  discard: (files: FileStatus[]) =>
    form({
      title: files.length === 1 ? `Discard changes to ${files[0].path}?` : `Discard changes to ${files.length} files?`,
      message: "A safety snapshot is saved first, so Ctrl+Z brings them back.",
      confirm: "Discard",
      danger: true,
      onSubmit: async () => {
        const untracked = files.filter((f) => f.kind === "untracked").map((f) => f.path);
        const tracked = files.filter((f) => f.kind !== "untracked").map((f) => f.path);
        st().setOpenFile(null);
        await st().act("Discard changes", (r) => api.discard(r, tracked, untracked), true);
      },
    }),

  settings: async () => {
    const repo = st().repo?.path;
    if (!repo) return;
    const id = await api.identity(repo);
    form({
      title: "Settings",
      message: `Gitolotl ${await getVersion().catch(() => "")} · ${id.gitVersion}. Credentials are handled by your git credential helper — Gitolotl never stores them. Click a person's picture in a commit to set it yourself. Made by CodeMushroom, © 2026.`,
      fields: [
        { key: "name", label: "Author name", type: "text", value: id.name },
        { key: "email", label: "Author email", type: "text", value: id.email },
        { key: "global", label: "Apply to all repositories (global)", type: "checkbox", value: false },
        {
          key: "vision", label: "Colours", type: "select", value: st().prefs.vision,
          options: [["default", "Standard"], ["redgreen", "Red-green colour blindness (deuteranopia, protanopia)"], ["blueyellow", "Blue-yellow colour blindness (tritanopia)"], ["contrast", "High contrast"]],
        },
        {
          key: "pictures", label: "Author pictures", type: "select", value: st().prefs.pictures,
          options: [["initials", "Initials only (nothing leaves this computer)"], ["online", "Gravatar and GitHub (sends a hash of each author's email to Gravatar)"]],
        },
      ],
      confirm: "Save",
      onSubmit: async (v) => {
        st().setPrefs({ vision: s(v.vision) as Vision, pictures: s(v.pictures) === "online" ? "online" : "initials" });
        if (s(v.name) !== id.name || s(v.email) !== id.email || v.global) await api.setIdentity(repo, s(v.name), s(v.email), !!v.global);
        st().toast("ok", "Settings saved");
      },
    });
  },

  /** Open a pull request for `from`, or ask which branch (the current one first). Any pushed branch will do. */
  createPr: (from?: string) => {
    const { status, gh, commits, repo, refs, remotes } = st();
    if (!gh || !repo) return void st().toast("err", "This repository has no GitHub remote.");
    const remote = remotes.find((r) => r.name === "origin")?.name ?? remotes[0]?.name;
    // A pull request is made from a branch on GitHub, so the choices are the pushed branches.
    const pushed = refs.filter((r) => r.kind === "remote" && r.short.startsWith(`${remote}/`) && !r.short.endsWith("/HEAD"));
    const onRemote = (name: string) => pushed.find((r) => r.short === `${remote}/${name}`);
    const local = (name: string) => refs.find((r) => r.kind === "head" && r.short === name);
    const unpushed = (name: string) => { const l = local(name); return l && l.upstream === `${remote}/${name}` ? l.ahead : 0; };
    if (from && !onRemote(from)) return void st().toast("err", `Push ${from} before opening a pull request.`);
    const cur = status?.branch ?? null;
    const names = pushed.map((r) => r.short.slice(remote!.length + 1));
    if (!names.length) return void st().toast("err", "Push a branch before opening a pull request.");
    // current branch first, then branches you have locally, then the rest
    const rank = (n: string) => (n === cur ? 0 : local(n) ? 1 : 2);
    names.sort((a, b) => rank(a) - rank(b));
    const head0 = from ?? (cur && onRemote(cur) ? cur : names[0]);
    const label = (n: string) => {
      const u = unpushed(n);
      return `${n}${n === cur ? " · current branch" : ""}${u ? ` · ${u} unpushed ${u === 1 ? "commit" : "commits"}` : ""}`;
    };
    const base0 = gh.defaultBranch ?? "main";
    const subject = (n: string) => commits.find((c) => c.hash === onRemote(n)?.hash)?.subject ?? n;
    form({
      title: `Open pull request — ${gh.owner}/${gh.name}`,
      message: !from && cur && !onRemote(cur) ? `${cur} has not been pushed yet, so it is not in the list.` : undefined,
      fields: [
        { key: "head", label: "From branch", type: "select", value: head0, options: names.map((n) => [n, label(n)] as [string, string]) },
        { key: "base", label: "Into (base branch)", type: "text", value: base0 },
        { key: "title", label: "Title", type: "text", value: subject(head0) },
        { key: "body", label: "Description", type: "textarea" },
        { key: "draft", label: "Create as draft", type: "checkbox", value: false },
      ],
      confirm: "Create pull request",
      // The suggested title follows the chosen branch until it has been edited.
      onChange: (k, val, before) => (k === "head" && before.title === subject(s(before.head)) ? { title: subject(String(val)) } : undefined),
      onSubmit: async (v) => {
        const head = s(v.head);
        const base = s(v.base);
        const u = unpushed(head);
        const later = u ? ` ${u} ${u === 1 ? "commit" : "commits"} on ${head} ${u === 1 ? "is" : "are"} not pushed yet.` : "";
        const nothing = new Error(`There is nothing to open a pull request for: ${base} already contains every commit on ${head}.${later ? `${later} Push first.` : ""}`);
        if (head === base) throw new Error("Choose two different branches.");
        // GitHub refuses an empty pull request with a terse message; say it plainly, before asking when we can tell.
        const tip = onRemote(head)?.hash;
        const baseTip = onRemote(base)?.hash;
        if (tip && baseTip && commits.some((c) => c.hash === baseTip)) {
          const parents = new Map(commits.map((c) => [c.hash, c.parents]));
          const seen = new Set<string>();
          for (const todo = [baseTip]; todo.length; ) {
            const h = todo.pop()!;
            if (!seen.has(h)) { seen.add(h); todo.push(...(parents.get(h) ?? [])); }
          }
          if (seen.has(tip)) throw nothing;
        }
        const pr = await api.githubCreatePr(repo.path, s(v.title), String(v.body ?? ""), head, base, !!v.draft).catch((e) => {
          throw String(e).includes("No commits between") ? nothing : e;
        });
        st().toast("ok", `Opened pull request #${pr.number}${later ? `\n${later.trim()} Push to add ${u === 1 ? "it" : "them"}.` : ""}`);
        void st().loadGithub(false);
        openExternal(pr.url);
      },
    });
  },
};

// ───────────────────────── context menus ─────────────────────────

const menu = (e: React.MouseEvent, items: MenuItem[]) => {
  e.preventDefault();
  e.stopPropagation();
  st().set({ menu: { x: e.clientX, y: e.clientY, items } });
};

export const commitMenu = (e: React.MouseEvent, c: Commit) => {
  const cur = st().status?.branch ?? "HEAD";
  menu(e, [
    { label: "Checkout this commit", onClick: () => A.checkout(c.hash, "commit") },
    { label: "Create branch here…", onClick: () => A.newBranch(c.hash) },
    { label: "Create tag here…", onClick: () => A.newTag(c.hash) },
    { sep: true },
    { label: "Cherry-pick commit", onClick: () => A.cherryPick(c.hash) },
    { label: "Revert commit", onClick: () => A.revert(c.hash) },
    { label: `Merge into ${cur}…`, onClick: () => A.merge(c.hash) },
    { label: `Rebase ${cur} onto this…`, onClick: () => A.rebase(c.hash) },
    { label: "Interactive rebase from here…", onClick: () => A.irebase(c.hash) },
    { label: `Reset ${cur} to this commit…`, danger: true, onClick: () => A.reset(c.hash) },
    { sep: true },
    { label: "Review all changes", onClick: () => A.reviewAll("commit", c.hash) },
    { label: "Copy diff for AI", onClick: () => A.copyForAi("commit", c.hash) },
    { label: "Copy commit hash", onClick: () => copy(c.hash) },
    { label: "Copy commit message", onClick: () => copy(c.subject) },
  ]);
};

export const refMenu = (e: React.MouseEvent, r: RefInfo) => {
  const cur = st().status?.branch ?? "HEAD";
  const items: MenuItem[] = [];
  if (r.kind === "tag") {
    items.push(
      { label: "Checkout tag (detached)", onClick: () => A.checkout(r.short, "tag") },
      { label: "Create branch here…", onClick: () => A.newBranch(r.short) },
      { label: "Push tag", onClick: () => A.pushTag(r.short) },
      { sep: true },
      { label: "Delete tag…", danger: true, onClick: () => A.deleteTag(r.short) },
    );
  } else {
    items.push({ label: `Checkout ${r.short}`, disabled: r.isHead, onClick: () => A.checkout(r.short, r.kind) });
    if (!r.isHead) {
      items.push(
        { label: `Merge into ${cur}…`, onClick: () => A.merge(r.short) },
        { label: `Rebase ${cur} onto ${r.short}…`, onClick: () => A.rebase(r.short) },
      );
    }
    items.push({ label: "Create branch here…", onClick: () => A.newBranch(r.short) });
    if (r.kind === "head") items.push({ label: "Rename…", onClick: () => A.renameBranch(r.short) });
    if (st().gh) items.push({ label: "Open pull request…", onClick: () => A.createPr(r.kind === "remote" ? r.short.slice(r.short.indexOf("/") + 1) : r.short) });
    items.push({ sep: true }, { label: "Delete…", danger: true, disabled: r.isHead, onClick: () => A.deleteBranch(r) });
  }
  items.push({ sep: true }, { label: "Copy name", onClick: () => copy(r.short) });
  menu(e, items);
};

export const backupMenu = (e: React.MouseEvent, b: Backup) =>
  menu(e, [
    { label: "Undo this (restore)", onClick: () => A.restore(b) },
    { label: "View what was saved", onClick: () => { st().select({ type: "commit", hash: b.hash }); A.reviewAll("commit", b.hash); } },
    { label: "Re-apply these changes (cherry-pick)", onClick: () => A.cherryPick(b.hash) },
    { label: "Create branch from snapshot…", onClick: () => A.newBranch(b.hash) },
    { label: "Copy hash", onClick: () => copy(b.hash) },
    { sep: true },
    {
      label: "Delete snapshot…", danger: true,
      onClick: () => form({
        title: "Delete this safety snapshot?", message: "This is the one thing Gitolotl cannot undo.", confirm: "Delete", danger: true,
        onSubmit: async () => { await st().act("Delete snapshot", (r) => api.deleteBackup(r, b.name), true); },
      }),
    },
  ]);

export const stashMenu = (e: React.MouseEvent, x: Stash) =>
  menu(e, [
    { label: "Apply", onClick: () => A.stashOp("apply", x.index) },
    { label: "Pop", onClick: () => A.stashOp("pop", x.index) },
    { sep: true },
    { label: "Drop…", danger: true, onClick: () => A.stashOp("drop", x.index) },
  ]);

export const remoteMenu = (e: React.MouseEvent, name: string) =>
  menu(e, [
    { label: "Add remote…", onClick: () => A.addRemote() },
    { label: `Remove ${name}…`, danger: true, onClick: () => A.removeRemote(name) },
  ]);

export const prMenu = (e: React.MouseEvent, pr: PullRequest) => {
  const remoteRef = st().refs.find((r) => r.kind === "remote" && r.short.endsWith(`/${pr.head}`));
  menu(e, [
    { label: "Open on GitHub", onClick: () => openExternal(pr.url) },
    { label: `Checkout ${pr.head}`, disabled: !remoteRef, onClick: () => remoteRef && A.checkout(remoteRef.short, "remote") },
  ]);
};

export const pullMenu = (e: React.MouseEvent) =>
  menu(e, [
    { label: "Pull (merge)", onClick: () => A.pull("merge") },
    { label: "Pull (rebase)", onClick: () => A.pull("rebase") },
    { label: "Pull (fast-forward only)", onClick: () => A.pull("ff-only") },
  ]);

export const pushMenu = (e: React.MouseEvent) =>
  menu(e, [
    { label: "Push", onClick: () => A.push() },
    { label: "Push all tags", onClick: () => { const remote = st().remotes[0]?.name; if (remote) void st().act("Push tags", (r) => api.push(r, { remote, tags: true })); } },
    { sep: true },
    { label: "Force push (with lease)…", danger: true, onClick: () => A.forcePush() },
  ]);

export const fileMenu = (e: React.MouseEvent, f: FileStatus, staged: boolean) =>
  menu(e, [
    staged
      ? { label: "Unstage", onClick: () => st().act("Unstage", (r) => api.unstage(r, [f.path]), true) }
      : { label: "Stage", onClick: () => st().act("Stage", (r) => api.stage(r, [f.path]), true) },
    ...(f.kind === "conflict"
      ? [
          { label: "Resolve using ours", onClick: () => st().act("Resolve (ours)", (r) => api.resolveConflict(r, f.path, "ours"), true) },
          { label: "Resolve using theirs", onClick: () => st().act("Resolve (theirs)", (r) => api.resolveConflict(r, f.path, "theirs"), true) },
        ]
      : []),
    ...(f.kind !== "untracked"
      ? [
          { label: "Blame", onClick: () => st().setOpenFile({ kind: "worktree", path: f.path, view: "blame" }) },
          { label: "File history", onClick: () => st().setOpenFile({ kind: "worktree", path: f.path, view: "history" }) },
        ]
      : []),
    { sep: true },
    { label: "Copy path", onClick: () => copy(f.path) },
    ...(!staged ? [{ sep: true }, { label: "Discard changes…", danger: true, onClick: () => A.discard([f]) }] : []),
  ]);
