# Changelog

The section for a version becomes the "What's new" text of its release and of the in-app update prompt.
Keep entries short and written for users.

## 0.2.6

- Branch and tag labels have their own column to the left of the graph, so they no longer squeeze the commit message. A branch and its remote copy on the same commit share one label; extra labels show as "+2" and open on hover.
- The branch you are on is always the first line of the graph, and the WIP row is joined to it by a dashed line and says which branch your changes are on and how many are staged.
- The changes panel is headed with the branch you are working on. Clicking the branch name in the toolbar jumps to it in the graph.
- When an open repository's folder no longer exists (for example a removed worktree), Gitolotl says so once and closes its tab instead of repeating "Not a directory".

## 0.2.5

- The graph now shows where a branch started: its line runs down to the commit it was cut from instead of folding into a neighbouring line.
- Open pull request lets you pick any pushed branch, not only the one checked out. You can also right-click a branch and choose "Open pull request…".
- An empty pull request is explained in plain words instead of "422 Validation Failed", and branches with unpushed commits are marked.

## 0.2.4

- The sidebar and the right panel can be resized: drag their edge.
- The commit list has a header, and its Graph, Author and Date columns can be resized by dragging the dividers. Double-click a divider to reset it. Sizes are remembered.

## 0.2.3

- Fixed Pull failing with "There is no tracking information for the current branch" on a branch created in 0.2.2. Pull now uses the branch of the same name on the remote and remembers it; if the branch was never pushed, it says so.
- A branch created from the remote branch of the same name (`fix-1` from `origin/fix-1`) tracks it again.

## 0.2.2

- Create branch now asks where to start from (default branch first, as in GitHub Desktop) and whether to bring your uncommitted changes along or leave them behind as a stash.
- Primary branches (default, main, master, staging, develop) are pinned to the top of the branch lists.
- Branch labels in the graph now match the colour of their line.
- Gitolotl is now open source under the Apache License 2.0.

## 0.2.1

- Colour settings for colour-blind users: red-green and blue-yellow presets and a high-contrast mode, in Settings.
- Author pictures: click an avatar to set a picture for that person, or turn on online pictures (GitHub and Gravatar) in Settings.
- Update reminders: when a new version is out, Gitolotl tells you, and reminds you once a day until you install it.
- Fixed "None of the fallback platforms were found" when checking for updates while a release was still being published.
- Risk flags now catch passwords embedded in URLs.
- Fixed file paths that start with a dot being shown with the dot in the wrong place.

## 0.2.0

- Undo: Ctrl+Z reverses the last destructive action (discard, reset, rebase, amend, deleted branch, tag or stash).
- Merge editor: resolve conflicts block by block with ours, theirs, both, or your own edit.
- Stage, unstage or discard individual lines, not just hunks.
- Worktree dashboard: see every checkout, its uncommitted work and who committed last; create and remove worktrees.
- Review tools for AI-written code: risk flags on changes that touch secrets, CI, dependencies, migrations or tests, and a reminder before pushing AI-assisted commits you have not marked as reviewed.
- Syntax colouring in diffs and blame.
- `gitolotl snapshot` lets scripts and AI agents save a safety snapshot before they start.
- Download files now have plain names such as `Gitolotl-0.2.0-Windows-setup.exe`.

## 0.1.0

- First release: commit graph, staging, diffs, blame, branches, tags, stashes, merge, rebase, interactive rebase, remotes, GitHub pull requests, AI commit badges, review-all view, command palette, safety snapshots, signed auto-updates.
