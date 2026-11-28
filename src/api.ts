import { invoke } from "@tauri-apps/api/core";

export interface RepoInfo { path: string; name: string }
export interface FileStatus { path: string; origPath: string | null; x: string; y: string; kind: "tracked" | "untracked" | "conflict" }
export interface Status {
  head: string; branch: string | null; upstream: string | null; ahead: number; behind: number;
  files: FileStatus[]; state: "" | "merge" | "rebase" | "cherry-pick" | "revert" | "bisect";
}
export interface Commit { hash: string; parents: string[]; author: string; email: string; time: number; subject: string; refs: string[]; coauthors: string[] }
export interface Backup { name: string; hash: string; time: number; label: string; detail: string; subject: string }
export interface WorktreeDetail {
  path: string; branch: string | null; head: string; current: boolean; missing: boolean;
  dirty: number; ahead: number; behind: number; hasUpstream: boolean; last: Commit | null;
}
export interface Worktree { path: string; head: string; branch: string | null; current: boolean }
export interface RefInfo {
  name: string; short: string; kind: "head" | "remote" | "tag"; hash: string;
  upstream: string | null; ahead: number; behind: number; gone: boolean; isHead: boolean;
  /** its newest commit was written by the user */
  mine: boolean;
  /** when its newest commit was made (unix seconds) */
  time: number;
}
export interface Risk { what: string; value: string; why: string }
export interface RepoRisks { items: Risk[]; fingerprint: string }
export interface Remote { name: string; url: string }
export interface Stash { index: number; hash: string; time: number; message: string }
export interface ChangedFile { status: string; path: string; oldPath: string | null }
export interface CommitDetails {
  hash: string; parents: string[]; author: string; email: string; time: number;
  committer: string; committerEmail: string; commitTime: number; message: string; signature: string; files: ChangedFile[];
}
export interface DiffOut { text: string; truncated: boolean }
export interface BlameLine { hash: string; author: string; time: number; summary: string; line: number; text: string }
export interface TodoCommit { hash: string; subject: string; merge: boolean }
export interface Identity { name: string; email: string; gitVersion: string }
export interface GithubInfo { owner: string; name: string; login: string | null; defaultBranch: string | null }
export interface PullRequest { number: number; title: string; author: string; head: string; base: string; url: string; draft: boolean; updated: string }
export type DiffKind = "worktree" | "staged" | "untracked" | "commit";

const call = <T>(cmd: string, args?: Record<string, unknown>) => invoke<T>(cmd, args);

export const api = {
  repoOpen: (path: string) => call<RepoInfo>("repo_open", { path }),
  /** watch this repository's folder for outside changes (null: stop); they arrive as "repo-changed" events */
  watch: (repo: string | null) => call<void>("watch_repo", { repo }),
  repoRisks: (repo: string) => call<RepoRisks>("repo_risks", { repo }),
  repoInit: (path: string) => call<RepoInfo>("repo_init", { path }),
  repoClone: (url: string, parent: string, name: string) => call<RepoInfo>("repo_clone", { url, parent, name }),
  status: (repo: string) => call<Status>("get_status", { repo }),
  log: (repo: string, limit: number, all: boolean, path?: string, mine = false) => call<Commit[]>("get_log", { repo, limit, all, path, mine }),
  refs: (repo: string) => call<RefInfo[]>("get_refs", { repo }),
  remotes: (repo: string) => call<Remote[]>("get_remotes", { repo }),
  stashes: (repo: string) => call<Stash[]>("get_stashes", { repo }),
  details: (repo: string, hash: string) => call<CommitDetails>("get_commit_details", { repo, hash }),
  diff: (repo: string, kind: DiffKind, path: string, hash?: string, oldPath?: string | null) =>
    call<DiffOut>("get_diff", { repo, kind, path, hash, oldPath }),
  patch: (repo: string, kind: "worktree" | "staged" | "commit", hash?: string) => call<DiffOut>("get_patch", { repo, kind, hash }),
  backups: (repo: string) => call<Backup[]>("get_backups", { repo }),
  deleteBackup: (repo: string, name: string) => call<void>("delete_backup", { repo, name }),
  restoreBackup: (repo: string, name: string) => call<string>("restore_backup", { repo, name }),
  conflictText: (repo: string, path: string) => call<string>("get_conflict", { repo, path }),
  resolveWithContent: (repo: string, path: string, content: string) => call<void>("resolve_with_content", { repo, path, content }),
  worktreeDetails: (repo: string) => call<WorktreeDetail[]>("get_worktree_details", { repo }),
  addWorktree: (repo: string, path: string, branch: string, create: boolean) => call<string>("add_worktree", { repo, path, branch, create }),
  removeWorktree: (repo: string, path: string) => call<string>("remove_worktree", { repo, path }),
  unpushed: (repo: string) => call<string[]>("get_unpushed", { repo }),
  worktrees: (repo: string) => call<Worktree[]>("get_worktrees", { repo }),
  blame: (repo: string, path: string, rev?: string) => call<BlameLine[]>("get_blame", { repo, path, rev }),
  stage: (repo: string, paths: string[]) => call<void>("stage", { repo, paths }),
  stageAll: (repo: string) => call<void>("stage_all", { repo }),
  unstage: (repo: string, paths: string[]) => call<void>("unstage", { repo, paths }),
  unstageAll: (repo: string) => call<void>("unstage_all", { repo }),
  discard: (repo: string, tracked: string[], untracked: string[]) => call<void>("discard", { repo, tracked, untracked }),
  applyPatch: (repo: string, patch: string, cached: boolean, reverse: boolean) => call<void>("apply_patch", { repo, patch, cached, reverse }),
  commit: (repo: string, message: string, amend: boolean, signoff: boolean) => call<string>("commit", { repo, message, amend, signoff }),
  lastMessage: (repo: string) => call<string>("last_commit_message", { repo }),
  resolveConflict: (repo: string, path: string, side: "ours" | "theirs") => call<void>("resolve_conflict", { repo, path, side }),
  checkout: (repo: string, target: string, kind: string) => call<string>("checkout", { repo, target, kind }),
  createBranch: (repo: string, name: string, start: string | undefined, checkout: boolean, changes?: "bring" | "leave") => call<string>("create_branch", { repo, name, start, checkout, changes }),
  defaultBranch: (repo: string) => call<string | null>("default_branch", { repo }),
  mergedBranches: (repo: string, into: string) => call<string[]>("merged_branches", { repo, into }),
  deleteBranch: (repo: string, name: string, force: boolean) => call<string>("delete_branch", { repo, name, force }),
  renameBranch: (repo: string, old: string, newName: string) => call<string>("rename_branch", { repo, old, new: newName }),
  deleteRemoteBranch: (repo: string, remote: string, name: string) => call<string>("delete_remote_branch", { repo, remote, name }),
  createTag: (repo: string, name: string, target?: string, message?: string) => call<string>("create_tag", { repo, name, target, message }),
  deleteTag: (repo: string, name: string) => call<string>("delete_tag", { repo, name }),
  merge: (repo: string, target: string, mode: string) => call<string>("merge", { repo, target, mode }),
  rebase: (repo: string, onto: string) => call<string>("rebase", { repo, onto }),
  cherryPick: (repo: string, hash: string) => call<string>("cherry_pick", { repo, hash }),
  revert: (repo: string, hash: string) => call<string>("revert", { repo, hash }),
  reset: (repo: string, target: string, mode: string) => call<string>("reset", { repo, target, mode }),
  opContinue: (repo: string, state: string) => call<string>("op_continue", { repo, state }),
  opAbort: (repo: string, state: string) => call<string>("op_abort", { repo, state }),
  opSkip: (repo: string) => call<string>("op_skip", { repo }),
  rebaseCandidates: (repo: string, from: string) => call<TodoCommit[]>("rebase_candidates", { repo, from }),
  rebaseInteractive: (repo: string, from: string, todo: { action: string; hash: string }[]) => call<string>("rebase_interactive", { repo, from, todo }),
  fetch: (repo: string) => call<string>("fetch", { repo }),
  pull: (repo: string, mode: string) => call<string>("pull", { repo, mode }),
  push: (repo: string, o: { remote?: string; branch?: string; force?: boolean; setUpstream?: boolean; tags?: boolean }) =>
    call<string>("push", { repo, remote: o.remote, branch: o.branch, force: !!o.force, setUpstream: !!o.setUpstream, tags: !!o.tags }),
  addRemote: (repo: string, name: string, url: string) => call<string>("add_remote", { repo, name, url }),
  removeRemote: (repo: string, name: string) => call<string>("remove_remote", { repo, name }),
  stashPush: (repo: string, message: string, includeUntracked: boolean) => call<string>("stash_push", { repo, message, includeUntracked }),
  stashOp: (repo: string, op: "apply" | "pop" | "drop", index: number, hash?: string) => call<string>("stash_op", { repo, op, index, hash }),
  identity: (repo: string) => call<Identity>("get_identity", { repo }),
  setIdentity: (repo: string, name: string, email: string, global: boolean) => call<void>("set_identity", { repo, name, email, global }),
  githubInfo: (repo: string, interactive: boolean) => call<GithubInfo>("github_info", { repo, interactive }),
  githubPrs: (repo: string) => call<PullRequest[]>("github_prs", { repo }),
  githubCreatePr: (repo: string, title: string, body: string, head: string, base: string, draft: boolean) =>
    call<PullRequest>("github_create_pr", { repo, title, body, head, base, draft }),
};
