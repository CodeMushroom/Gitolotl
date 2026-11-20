# Safety: how Gitolotl protects your repository

No tool that can run `git reset --hard` for you can promise it will never cost you work. What Gitolotl
does promise is narrower and testable: **it never changes anything unless you ask, and everything it
destroys at your request is saved first.** Each claim below is enforced by a test in
`src-tauri/src/git.rs`.

## 1. Looking never writes

Opening a repository, browsing history, viewing diffs and blame, and the background refresh run only
read commands, with `GIT_OPTIONAL_LOCKS=0` so they never take `index.lock`. They cannot collide with a
terminal, an IDE or an AI agent running git in the same repository.

*Test `reading_never_writes`*: fingerprints every file in a repository, including all of `.git`, runs
every read command, and asserts nothing was created, removed or modified.

There is no background fetch, no auto-stash, no auto-commit and no auto-update of anything.

## 2. Destructive actions are snapshotted first

Before any operation that can lose work, Gitolotl records what is about to be destroyed under
`refs/gitolotl/backup/`:

| Action | What is saved |
| --- | --- |
| Discard changes / discard hunk | The whole working tree, **including untracked files** |
| Reset `--hard` | The working tree and the old `HEAD` |
| Reset (soft / mixed), amend, rebase, interactive rebase | The old `HEAD` |
| Abort or skip during a merge / rebase / cherry-pick / revert | The working tree, including your partial conflict resolution |
| Resolve a conflict with ours / theirs, or save from the merge editor | The working tree, including your manual edits |
| Delete branch (local or remote), delete tag | The commit it pointed at |
| Drop stash | The stash commit |

Working-tree snapshots are built with a temporary index, so the real index, your working files, `HEAD`
and the stash list are not touched by taking one.

**Fail closed:** if a snapshot cannot be taken, the action is refused with "nothing was changed".

*Test `destructive_operations_are_recoverable`*: performs each action above, then reads the lost
content back out of the backup, and confirms the backups survive `git reflog expire` plus `git gc
--prune=now`.

### Restoring

`Ctrl+Z` undoes the most recent action. Every snapshot is also listed under **Safety snapshots** in the
sidebar: right-click one to undo that action, view what it holds, re-apply the changes, or create a
branch from it. The newest 200 are kept.

Undo is conservative. It snapshots the current state before changing anything, moves a branch only with
`git reset --keep` (which refuses to overwrite local changes), and refuses outright if you are no longer
on the branch the action was performed on.

*Test `undo_restores_what_was_lost`*: discards, hard-resets, amends, deletes a branch and a tag and drops
a stash, undoes each, and checks the exact content and commit come back; then checks an undo recorded on
one branch will not move another.

They are ordinary git refs, so they work without Gitolotl too:

```bash
git for-each-ref refs/gitolotl/backup/
git show <hash>                 # what was saved
git cherry-pick -n <hash>       # put the changes back in your working tree
git branch rescue <hash>        # or keep it as a branch
```

They are local only. Git never pushes `refs/gitolotl/*` unless you explicitly name them.

### Snapshots for scripts and agents

`gitolotl snapshot [folder]` takes the same working-tree snapshot from the command line, so an AI agent
or script can save your state before it starts. It only adds a ref; it never changes files.

## 3. Nothing surprising is sent to a remote

- Push only pushes the current branch (or the tag you chose). There is no "push all".
- Force push always uses `--force-with-lease --force-if-includes`: git refuses it if the remote has
  commits you have not fetched **and integrated**, so you cannot silently overwrite a teammate.
- Deleting a remote branch asks first, says it affects everyone, and saves the tip locally.

## 4. Git itself stays in charge

Gitolotl never edits files in `.git` directly. Every change is made by the `git` binary, so git's own
protections still apply: it refuses a checkout that would overwrite local changes, refuses to delete an
unmerged branch without force, refuses a rebase on a dirty tree, and so on. Gitolotl shows git's message
and stops.

Arguments are validated before git runs (see [Architecture](ARCHITECTURE.md#security-model)), so a
branch or file name can never be misread as an option.

## What is not covered

- **Ignored files.** Snapshots skip files matched by `.gitignore` (build output, `node_modules`, `.env`).
  Discard never deletes ignored files either, so they are not at risk from Gitolotl.
- **Deleting a safety snapshot** is itself permanent, and asks first.
- **Unstaging** changes the index only. If you staged a version of a file and then edited it further,
  unstaging keeps your latest edits but the intermediate staged version is gone.
- **Hooks and repository config** run exactly as they would on the command line. Gitolotl cannot vouch
  for what a repository's own hooks do.
- **The remote side.** Once a force push or remote branch deletion is accepted by the server, recovery
  depends on the local backup (which Gitolotl keeps) being pushed back.
- **Bugs.** The guarantees above are tested on Windows on every change, and on macOS and Linux in CI. A
  defect in Gitolotl or in git could still exist; the snapshot layer is there precisely so that a
  mistake, yours or ours, is recoverable.
