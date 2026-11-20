# Changelog

The section for a version becomes the "What's new" text of its release and of the in-app update prompt.
Keep entries short and written for users.

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
