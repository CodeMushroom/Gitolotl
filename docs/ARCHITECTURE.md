# Architecture

Gitolotl is a [Tauri 2](https://tauri.app) app: a Rust backend that drives the system `git`, and a React
+ TypeScript UI rendered in the operating system's webview. The two halves talk only through typed
commands.

```
┌──────────────────────── webview (untrusted side) ─────────────────────────┐
│ React UI  ──  store.ts (zustand)  ──  api.ts (typed invoke wrappers)       │
└──────────────────────────────────┬────────────────────────────────────────┘
                                   │ Tauri IPC: named commands, JSON args
┌──────────────────────────────────▼────────────────────────────────────────┐
│ Rust: git.rs (validate → spawn `git`)      github.rs (api.github.com)      │
└────────────────────────────────────────────────────────────────────────────┘
```

## Layout

| Path | Purpose |
| --- | --- |
| `src-tauri/src/git.rs` | Every git operation, input validation, output parsing, and the backend tests |
| `src-tauri/src/github.rs` | Pull request listing / creation; credential lookup |
| `src-tauri/src/lib.rs` | App setup, plugin registration, the command list |
| `src-tauri/tauri.conf.json` | Window, CSP, bundle and updater configuration |
| `src-tauri/capabilities/default.json` | What the webview is allowed to ask Tauri for |
| `src/api.ts` | TypeScript types and one wrapper per backend command |
| `src/store.ts` | Application state and the `act` / `refresh` cycle |
| `src/actions.ts` | User-facing actions, dialogs and context menus |
| `src/graph.ts` | Lane layout for the commit graph |
| `src/diff.ts` | Unified diff parsing, per-hunk patch building, multi-file patch splitting |
| `src/ai.ts` | Detecting AI agents from author / co-author |
| `src/risk.ts` | Pattern-based risk flags for a file's diff |
| `src/syntax.ts` | Small per-line syntax colourer (no dependency) |
| `scripts/test-lines-patch.mjs` | Verifies line-level patches against real git |
| `src/components/Icon.tsx` | Inline SVG icons and author avatars |
| `src/components/` | `Graph`, `Panel` (staging + commit details), `DiffView`, `MergeEditor`, `Worktrees`, `Sidebar`, `Toolbar`, `Palette`, `Overlays` |

## Backend

All git work goes through `exec()` in `git.rs`, which builds one `std::process::Command`:

- `git` is spawned directly with an argument array. There is no shell and no string concatenation.
- Fixed global options: `core.quotepath=false`, `color.ui=false`, `protocol.ext.allow=never`.
- Fixed environment: `GIT_OPTIONAL_LOCKS=0` (reads never take `index.lock`), `GIT_TERMINAL_PROMPT=0`
  (never block on a hidden prompt), `GIT_EDITOR=true` and
  `GIT_SEQUENCE_EDITOR=true` (never open an editor), `LC_MESSAGES=C` (stable output to parse).
- Machine-readable formats throughout: `status --porcelain=v2 -z`, `log` with `%x1f` / `%x1e`
  separators, `for-each-ref --format`, `blame --porcelain`, `worktree list --porcelain`.

Commands are declared `#[tauri::command(async)]` so the blocking process call runs off the UI thread.
They return `Result<T, String>`; the string is git's own stderr, shown to the user as-is.

**Interactive rebase** never opens an editor. The UI sends an ordered list of `{action, hash}`; the
backend validates it, writes a todo file to the temp directory, and sets `GIT_SEQUENCE_EDITOR` to a
fixed `sh` one-liner that copies that file (its path travels in an environment variable, so nothing is
shell-quoted).

**Hunk and line staging** is done in the UI: `diff.ts` rebuilds a patch from the file header plus one
hunk (`hunkPatch`) or only the selected lines of it (`linesPatch`), and the backend pipes it to
`git apply --cached` (or `--reverse`) on stdin.

**The merge editor** is the only place Gitolotl writes a working file itself: `resolve_with_content`
accepts a path only if git lists it as unmerged and it cannot leave the repository, snapshots first, then
writes the file and stages it.

**Undo** (`restore_backup`) dispatches on the label stored in the backup ref's name; the branch or tag
name is stored there too (`…-delete-branch/feature/x`), so nothing else needs to be persisted.

## Safety net

Every destructive command calls `snapshot_worktree()` and / or `backup_tip()` before it runs git. Both
write a ref under `refs/gitolotl/backup/`; a failed snapshot aborts the command. `snapshot_worktree()`
copies the real index to a temp file, points `GIT_INDEX_FILE` at it, and runs `add -A`, `write-tree` and
`commit-tree`, so the user's index, working tree, `HEAD` and stash are untouched. A new destructive
command must do the same and be added to the `destructive_operations_are_recoverable` test. See
[Safety](SAFETY.md).

## Security model

The webview is treated as the less trusted side: a diff or commit message is attacker-controlled text.

1. **Typed commands only.** There is no "run git with these arguments" command.
2. **Argument validation** (`rf`, `hex`, `paths_ok`, `clone_url_ok` in `git.rs`): refs and remote names
   may not be empty, start with `-`, or contain control characters; commit ids must be hex; paths are
   always placed after `--`; clone / remote URLs must be `https://`, `ssh://`, `user@host:path` or an
   existing local folder.
3. **Credentials stay out of the UI.** Git's own helper handles authentication. `github.rs` asks
   `git credential fill` for the GitHub token, keeps it in process memory, and sends it only to
   `https://api.github.com`. Remote URLs containing `user:token@` are redacted before reaching the UI.
4. **Webview hardening.** CSP allows only bundled scripts and styles, with no remote content.
   Capabilities grant the folder picker, opening `https://github.com/*`, the updater and restart, and
   nothing else. All text is rendered through React (no `dangerouslySetInnerHTML`).
5. **Signed updates.** See [Releasing](RELEASING.md).

Known limits: git hooks and repository-level git config run as they would on the command line, so an
untrusted repository is as dangerous here as in any git client.

## Frontend

State lives in one zustand store (`store.ts`).

- `refresh()` reloads status, log, refs, remotes, stashes and worktrees in parallel.
- `refreshStatus()` is the cheap poll (every 4 s while focused, and on window focus). It reloads the
  full history only if `HEAD` or the branch changed.
- `act(label, fn)` wraps every mutating operation: sets the busy indicator, runs it, toasts the output
  or error, then refreshes. Index-only operations (stage / unstage / hunks) use the lighter `quick()`.

The graph is virtualised (fixed 28 px rows) and loads history 3,000 commits at a time as you scroll.
`layoutGraph()` assigns lanes in one pass over the commits in display order.

Dialogs are data: `actions.ts` describes a form (`fields`, `onSubmit`) and `Overlays.tsx` renders it, so
adding a dialog needs no new component.

## Adding a git operation

1. Write the command in `git.rs`. Validate every argument, pass paths after `--`, return `R<T>`.
2. Register it in the `generate_handler!` list in `lib.rs`.
3. Add a typed wrapper in `src/api.ts`.
4. Call it from `actions.ts` through `st().act(...)` and surface it in a menu, the toolbar or the palette.
5. Cover it in the `full_workflow` test in `git.rs`.

## Testing

```bash
cd src-tauri && cargo test --lib
```

`reading_never_writes` and `destructive_operations_are_recoverable` enforce the guarantees in
[Safety](SAFETY.md). `full_workflow` creates a real repository in the temp directory and exercises init, staging, hunk
patches, commits, log, blame, branches, tags, interactive rebase, stash, and a merge conflict through to
resolution. The other tests cover validation, URL redaction and parsing.

To preview the UI in a plain browser with real data, the ignored `dump_fixture` test writes the backend's
output for a repository to a JSON file that a mock `invoke` can serve; see the comment on that test.
