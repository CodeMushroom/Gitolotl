# Gitolotl user guide

## Getting started

On first launch you see the welcome screen: **Open repository**, **Clone…** or **Init new…**. Recently
opened repositories are listed underneath. Each repository opens in its own tab; the axolotl in the top
left returns to the welcome screen.

From a terminal, `gitolotl <folder>` opens that repository directly.

Gitolotl uses the `git` on your `PATH` and your existing git configuration, credential helper and SSH
agent. Nothing needs to be set up inside the app. Your name and email can be changed under **Settings**
(the gear, top right), per repository or globally.

## The window

| Area | What it shows |
| --- | --- |
| **Tabs** | Open repositories. `+` opens another. |
| **Toolbar** | Current branch, Fetch / Pull / Push (with behind / ahead counts), Branch, Stash, Pop, PR, filters and search. |
| **Sidebar** | Local branches, remotes, pull requests, worktrees, stashes, safety snapshots, tags. The filter box narrows all of them. |
| **Graph** | The commit history. A dashed **WIP** row at the top appears when you have uncommitted changes. |
| **Right panel** | The staging area (WIP selected) or the selected commit's details and files. |

Drag the edge of the sidebar or the right panel to resize it, and the dividers in the graph's header to resize
the Graph, Author and Date columns. Double-click a divider to reset it. The sizes are remembered.

Almost everything has a right-click menu: commits, branches, tags, stashes, remotes, files, and the Pull
and Push buttons.

## Keyboard

| Key | Action |
| --- | --- |
| `Ctrl+K` or `Ctrl+P` | Command palette |
| `j` / `k` or `↓` / `↑` | Next / previous commit |
| `Enter` | Review all files of the selected commit |
| `c` | Copy the selected commit's diff for AI |
| `w` | Jump to uncommitted changes |
| `/` | Focus commit search |
| `r` | Mark / unmark the selected commit as reviewed |
| `Ctrl+Z` | Undo the most recent destructive action |
| `Ctrl+Enter` | Commit (in the message box) |
| `Esc` | Close the palette, menu, dialog or diff |
| `F5` or `Ctrl+R` | Refresh |
| `Ctrl+O` | Open a repository |

On macOS use `Cmd` in place of `Ctrl`.

The **command palette** fuzzy-searches actions, branches to check out, tags, worktrees and commits (by
message, author or hash).

## Working with AI-written code

- **AI badges.** A commit whose author or `Co-authored-by` trailer names an AI agent (Claude, Copilot,
  Cursor, Codex, Gemini, Devin, Aider, Windsurf, Amazon Q, or any `[bot]`) gets a `✦` chip in the graph.
  **✦ AI only** in the toolbar filters the history to those commits.
- **Review all.** Shows every changed file in one scrolling view with `+` / `−` counts per file. Open it
  with `Enter` on a commit, **Review all** in the commit panel, or **Review** next to Unstaged / Staged.
  For pending changes each hunk has **Stage hunk**, **Unstage hunk** and **Discard hunk**, so you can
  accept an agent's work piece by piece.
- **Risk flags.** In Review all, files are flagged when the change looks like it adds a secret, edits CI
  configuration, changes dependencies or lockfiles, adds an install script, touches migrations or auth
  code, or removes tests. These are local pattern checks: a prompt to look closer, not a verdict.
- **Review gate.** Mark an AI-assisted commit as reviewed with `r` or **Mark reviewed** (its badge turns
  green). When you push, Gitolotl lists any AI-assisted commits in that push you have not marked, and
  offers **Review them** or **Push anyway**. Marks are kept on this machine only.
- **Copy for AI.** Copies a commit, the staged diff or the unstaged diff as a fenced `diff` block with a
  one-line heading, ready to paste into a chat ("write a commit message for this", "review this").
  Available from the commit panel, the staged header, the commit right-click menu, `c`, and the palette.
- **Worktrees.** When a repository has more than one worktree (the usual setup when agents work in
  parallel) they are listed in the sidebar; double-click one to open it in a tab. The **worktree
  dashboard** (the grid button on that section, or the palette) shows every checkout with its branch,
  uncommitted file count, ahead / behind, and last commit with the agent that made it, and lets you create
  or remove worktrees. Removal is never forced: git refuses if the worktree has uncommitted work.
- **Snapshots for agents.** `gitolotl snapshot [folder]` saves a safety snapshot of the working tree and
  exits without opening a window. It prints the snapshot's commit id, or `clean` if there was nothing to
  save. Call it from an agent's pre-run hook so you can always get back to where it started.

## Committing

1. Select the **WIP** row (or press `w`).
2. Click a file to see its diff. `+` stages a file, `−` unstages it; **Stage all** / **Unstage all** act
   on everything. In a diff, stage or discard individual hunks, or click the line numbers of changed
   lines (Shift-click for a range) to stage, unstage or discard just those lines.
3. Write a message (the counter shows the summary line length) and press `Ctrl+Enter`.

**Amend** rewrites the last commit and pre-fills its message. **Sign off** adds a `Signed-off-by` line.
**Discard** always asks first and saves a safety snapshot, so it can be undone.

## Branches, tags and stashes

- **Check out** by double-clicking a branch in the sidebar or its label in the graph. Checking out a
  remote branch creates a local tracking branch.
- **Create** with the Branch button, the `+` in the sidebar, or "Create branch here…" on a commit.
  The dialog asks where to **start from**: the default branch is offered first (with a warning, and the
  remote's copy as an alternative, when your local one is behind), then the current branch, then any
  other. If you have uncommitted changes it also asks whether to **bring them** to the new branch or
  **leave them** behind as a stash on the branch you were on. Either way nothing is lost: if the changes
  cannot come along, or the switch fails, your work is left exactly as it was.
- **Primary branches** (the remote's default branch, plus `main`, `master`, `staging`, `develop` and
  similar) are pinned to the top of the branch lists.
- **Branch labels in the graph take the colour of their line.** Local branches are tinted, remote
  branches are outlined with a cloud, and the checked-out branch is filled in.
- Right-click a branch to **merge** it into the current branch (fast-forward, merge commit, ff-only or
  squash), **rebase** onto it, **rename** or **delete** it. Deleting a remote branch deletes it for
  everyone and says so.
- Right-click a commit to **cherry-pick**, **revert**, **reset** the current branch to it, or start an
  **interactive rebase** from it.
- **Stash** stores your changes (untracked files included by default); right-click a stash to apply, pop
  or drop it.
- **Tags** can be lightweight or annotated (give a message). Right-click to push or delete.

### Interactive rebase

"Interactive rebase from here…" lists the commits from the chosen one up to `HEAD`, oldest first. For
each choose `pick`, `squash` (combine with the commit above, keep both messages), `fixup` (combine,
discard this message) or `drop`, and reorder with the arrows. If the range contains merges the result is
linear. If a step conflicts, resolve it and use the banner described below.

## Conflicts

When a merge, rebase, cherry-pick or revert stops, a banner appears above the staging area. Conflicted
files are marked `U`. Click one to open the **merge editor**: each conflict is shown with *ours* and
*theirs* side by side, and you choose **Use ours**, **Use theirs**, **Use both**, or **Edit by hand**.
When every conflict is decided, **Save and mark resolved** writes the file and stages it. You can also
right-click a file to resolve the whole file one way, or fix it in your own editor and stage it. Then
**Continue**, **Skip** (rebase only) or **Abort**.

## Undo and safety snapshots

**`Ctrl+Z` undoes the most recent destructive action**: it puts discarded files back, moves a branch
back after a reset, amend or rebase, and recreates a deleted branch, tag or stash. It asks first and
tells you exactly what it will do. An undo is itself undoable.

Before Gitolotl discards changes, hard-resets, rebases, amends, aborts an operation, or deletes a
branch, tag or stash, it saves what is about to be lost. These appear under **Safety snapshots** in the
sidebar, labelled with the action and time. Click one to see its contents; right-click to **undo that action**, **re-apply the
changes**, **create a branch** from it, or delete it. See [Safety](SAFETY.md) for exactly what is and is
not covered.

## Remotes and GitHub

- **Fetch** updates all remotes and prunes deleted branches.
- **Pull** merges by default; right-click for rebase or fast-forward only. On a branch with no upstream it pulls the
  branch of the same name from the remote and remembers it.
- **Push** publishes the current branch, setting its upstream on first push. Right-click for **Push all
  tags** and **Force push**, which uses `--force-with-lease --force-if-includes` and is refused if someone else pushed first.
- For repositories with a GitHub remote the sidebar lists open **pull requests** (double-click opens one
  in the browser) and the **PR** button opens a new one from the current branch.

GitHub access uses the token already stored by your git credential helper. If the sidebar shows
**Connect GitHub account**, click it to let the helper sign you in. Gitolotl never stores the token.

## Appearance

**Settings** (the gear) has two appearance options, both stored on this computer:

- **Colours**: Standard, Red-green colour blindness (deuteranopia, protanopia), Blue-yellow colour
  blindness (tritanopia), or High contrast. The presets change diff colours, file status badges and the
  graph's branch colours. Diffs also always carry `+` / `−` signs and badges carry letters, so nothing
  depends on colour alone.
- **Author pictures**: *Initials only* (the default; nothing leaves your computer) or *Gravatar and
  GitHub*. The online option loads pictures from GitHub for GitHub no-reply addresses and from Gravatar
  for everyone else, which means a SHA-256 hash of each author's email address is sent to Gravatar.

You can also set a picture for anyone yourself, with no network involved: open one of their commits,
click their picture, and choose an image file.

## Updates

Gitolotl checks for a new version on launch and every four hours while it is open. When one exists an
**Update to x.y.z** button appears at the top right and stays there, and a prompt shows what's new with
**Install and restart** or **Remind me tomorrow** (it asks at most once a day). You can also check from
the welcome screen or the command palette ("Check for updates"). Nothing is downloaded until you confirm.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| "Could not start git" | Install git and make sure it is on your `PATH`, then restart Gitolotl. |
| Push / fetch fails with an authentication error | Run the same command once in a terminal so your credential helper or SSH agent can sign in. |
| A passphrase-protected SSH key hangs or fails | Load the key into your SSH agent first; Gitolotl cannot show a passphrase prompt. |
| Pull requests do not load | Click **Connect GitHub account**, or sign in with `git credential-manager github login`. |
| The graph looks out of date | Press `F5`. The working tree is re-checked automatically every few seconds while the window is focused. |
