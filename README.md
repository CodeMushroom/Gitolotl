# Gitolotl

<img src="assets/axolotl.svg" width="110" align="right" alt="Gitolotl" />

**A friendly, secure Git client for Windows, macOS and Linux, by [CodeMushroom](https://github.com/CodeMushroom).**

Built for developers who review and steer a lot of AI-written code.

### [Download the latest release »](https://github.com/CodeMushroom/Gitolotl/releases/latest)

![Gitolotl showing a commit graph, branches and the staging area](assets/screenshot.png)

## Install

| Platform | Download from the latest release |
| --- | --- |
| **Windows** | `Gitolotl_x.y.z_x64-setup.exe` (per-user, no admin rights needed) or the `.msi` |
| **macOS** | `Gitolotl_x.y.z_aarch64.dmg` for Apple silicon, `_x64.dmg` for Intel |
| **Linux** | `.AppImage`, `.deb` or `.rpm` |

You need `git` 2.31 or newer installed.

The installers are not yet signed with a Windows or Apple certificate, so the first launch shows a
warning. On Windows choose **More info → Run anyway**; on macOS right-click the app and choose **Open**.

## Updates

Gitolotl checks this repository for a new version when it starts and asks before installing it. Every
update is cryptographically signed by CodeMushroom and verified by the app before it is applied.

## What it does

- Commit graph, staging by file and by hunk, diffs, blame and file history
- Branches, tags, stashes, worktrees, merge, rebase, interactive rebase, cherry-pick, revert, reset
- Conflict handling, remotes, force-push with lease, GitHub pull requests
- **AI-aware**: badges on commits written with Claude, Copilot, Cursor, Codex and others; review every
  file of a change in one scroll; copy any diff straight into an AI chat
- Command palette (`Ctrl+K`) and keyboard navigation

## Safe by design

- Gitolotl never changes a repository unless you ask it to.
- Anything it destroys at your request (discarded changes, hard resets, deleted branches, dropped
  stashes, rewritten history) is saved first as a **safety snapshot** you can restore.
- It never stores your credentials; sign-in is handled by your own git credential helper.

## About this repository

This repository hosts Gitolotl's installers and update files. The source code is developed privately.

## Credits

Gitolotl is made by **CodeMushroom**.

Copyright © 2026 CodeMushroom. All rights reserved.
