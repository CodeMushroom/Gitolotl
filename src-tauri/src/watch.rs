//! Tells the window when the open repository changes on disk, so that work done outside
//! Gitolotl (an editor, the git command line, an AI agent) shows up without a manual refresh.
//!
//! Watching only ever reads: it runs nothing in the repository and writes nothing to it.

use crate::git;
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::path::{Component, Path, PathBuf};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::Emitter;

/// Wait for this long without further changes before telling the window...
const QUIET: Duration = Duration::from_millis(250);
/// ...but never hold a change back for longer than this (a build can write files for minutes).
const LONGEST: Duration = Duration::from_millis(1000);

/// What a changed path means for the window. `None`: nothing it shows can have changed.
/// `Some(true)`: git's own data changed (a commit, checkout, fetch, stash, new branch...).
/// `Some(false)`: a file in the working tree changed.
fn classify(path: &Path, git_dirs: &[PathBuf]) -> Option<bool> {
    let names: Vec<String> = path
        .components()
        .filter_map(|c| match c {
            Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect();
    let in_git = names.iter().any(|n| n == ".git") || git_dirs.iter().any(|d| path.starts_with(d));
    if !in_git {
        return Some(false);
    }
    // The object store only ever gains files that something else then points at. Lock files
    // come and go around every write. The built-in file monitor drops a cookie file each time
    // git is asked for a status, which would otherwise make every refresh cause the next one.
    // A folder inside git's data reports a change whenever a file in it comes or goes, lock
    // files included, so only the files themselves count.
    let noise = names.iter().any(|n| n == "objects" || n.starts_with("fsmonitor--daemon"))
        || names.last().is_some_and(|n| n.ends_with(".lock") || n == ".git")
        || path.is_dir();
    if noise {
        None
    } else {
        Some(true)
    }
}

/// Watches `root` (and git's own folders when they live elsewhere, as for a linked worktree)
/// and calls `changed(git_data_changed)` once things have been quiet for a moment.
/// Dropping the returned watcher stops it.
pub fn start(root: &str, changed: impl Fn(bool) + Send + 'static) -> Result<RecommendedWatcher, String> {
    let top = git::dir(root)?;
    let out = git::run(root, &["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"])?;
    let mut git_dirs: Vec<PathBuf> = out.lines().filter(|l| !l.is_empty()).map(PathBuf::from).collect();
    git_dirs.dedup();

    let (tx, rx) = mpsc::channel::<bool>();
    let dirs = git_dirs.clone();
    let mut watcher = notify::recommended_watcher(move |ev: notify::Result<notify::Event>| {
        let Ok(ev) = ev else { return };
        if matches!(ev.kind, EventKind::Access(_)) {
            return;
        }
        for p in &ev.paths {
            if let Some(git) = classify(p, &dirs) {
                let _ = tx.send(git);
            }
        }
    })
    .map_err(|e| e.to_string())?;

    // The whole working tree. Where the system cannot watch that many folders (Linux has a
    // limit), git's own folders are still watched and the window's periodic check covers the rest.
    let whole = watcher.watch(&top, RecursiveMode::Recursive).is_ok();
    for d in &git_dirs {
        if !whole || !d.starts_with(&top) {
            let _ = watcher.watch(d, RecursiveMode::Recursive);
        }
    }

    // Collect a burst of changes into one notice. Ends when the watcher is dropped.
    std::thread::spawn(move || {
        while let Ok(mut git) = rx.recv() {
            let began = Instant::now();
            while began.elapsed() < LONGEST {
                match rx.recv_timeout(QUIET) {
                    Ok(more) => git |= more,
                    Err(_) => break,
                }
            }
            changed(git);
        }
    });
    Ok(watcher)
}

/// The one repository being watched: the one the window is showing.
#[derive(Default)]
pub struct Watching(Mutex<Option<RecommendedWatcher>>);

#[derive(Serialize, Clone)]
struct Changed {
    repo: String,
    /// git's own data changed, not only files in the working tree
    git: bool,
}

/// Watch `repo` instead of whatever was watched before; `None` stops watching.
#[tauri::command(async)]
pub fn watch_repo(app: tauri::AppHandle, state: tauri::State<Watching>, repo: Option<String>) -> Result<(), String> {
    let mut slot = state.0.lock().map_err(|e| e.to_string())?;
    *slot = None;
    if let Some(repo) = repo {
        let name = repo.clone();
        *slot = Some(start(&repo, move |git| {
            let _ = app.emit("repo-changed", Changed { repo: name.clone(), git });
        })?);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sorts_changes() {
        let dirs = [PathBuf::from("/elsewhere/main/.git/worktrees/wt"), PathBuf::from("/elsewhere/main/.git")];
        let c = |p: &str| classify(Path::new(p), &dirs);
        assert_eq!(c("/repo/src/app.ts"), Some(false));
        assert_eq!(c("/repo/node_modules/x/index.js"), Some(false));
        assert_eq!(c("/repo/.git/HEAD"), Some(true));
        assert_eq!(c("/repo/.git/index"), Some(true));
        assert_eq!(c("/repo/.git/refs/heads/feature/x"), Some(true));
        assert_eq!(c("/repo/.git/refs/remotes/origin/main"), Some(true));
        assert_eq!(c("/elsewhere/main/.git/worktrees/wt/HEAD"), Some(true));
        assert_eq!(c("/repo/.git/objects/ab/cdef"), None);
        assert_eq!(c("/repo/.git/index.lock"), None);
        assert_eq!(c("/repo/.git/refs/heads/x.lock"), None);
        assert_eq!(c("/repo/.git/fsmonitor--daemon/cookies/1-2"), None);
    }

    /// Against a real repository: outside changes are noticed and told apart, and Gitolotl
    /// looking at the repository never sets the watcher off (which would refresh for ever).
    #[test]
    fn notices_outside_changes_only() {
        let root = std::env::temp_dir().join(format!("gitolotl-watch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let repo = root.to_string_lossy().into_owned();
        git::repo_init(repo.clone()).unwrap();
        git::set_identity(repo.clone(), "Axo Lotl".into(), "axo@example.com".into(), false).unwrap();
        for (k, v) in [("commit.gpgsign", "false"), ("gc.auto", "0"), ("maintenance.auto", "false")] {
            git::run(&repo, &["config", k, v]).unwrap();
        }
        std::fs::write(root.join("a.txt"), "one").unwrap();
        git::stage_all(repo.clone()).unwrap();
        git::commit(repo.clone(), "first".into(), false, false).unwrap();

        let (tx, rx) = mpsc::channel::<bool>();
        let watcher = start(&repo, move |git| {
            let _ = tx.send(git);
        })
        .unwrap();
        let settle = || while rx.recv_timeout(Duration::from_millis(1500)).is_ok() {};
        let next = || rx.recv_timeout(Duration::from_secs(10));
        settle();

        // someone edits a file
        std::fs::write(root.join("a.txt"), "two").unwrap();
        assert_eq!(next(), Ok(false), "a file edit is a working-tree change");
        settle();

        // someone uses the git command line
        git::run(&repo, &["branch", "made-outside"]).unwrap();
        assert_eq!(next(), Ok(true), "a new branch is a change to git's data");
        settle();
        git::run(&repo, &["add", "a.txt"]).unwrap();
        assert_eq!(next(), Ok(true), "staging changes the index");
        settle();
        git::run(&repo, &["checkout", "-q", "made-outside"]).unwrap();
        assert_eq!(next(), Ok(true), "switching branch moves HEAD");
        settle();

        // someone deletes a file
        std::fs::remove_file(root.join("a.txt")).unwrap();
        assert!(next().is_ok(), "a deleted file is noticed");
        settle();

        // everything a refresh reads must leave the watcher silent
        git::get_status(repo.clone()).unwrap();
        git::get_refs(repo.clone()).unwrap();
        git::get_log(repo.clone(), 100, true, None, false).unwrap();
        git::get_stashes(repo.clone()).unwrap();
        git::get_worktrees(repo.clone()).unwrap();
        git::get_backups(repo.clone()).unwrap();
        git::default_branch(repo.clone()).unwrap();
        assert!(rx.recv_timeout(Duration::from_secs(2)).is_err(), "a refresh must not look like a change");

        drop(watcher);
        let _ = std::fs::remove_dir_all(&root);
    }
}
