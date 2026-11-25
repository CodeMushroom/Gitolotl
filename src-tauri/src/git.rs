//! Typed, argument-safe wrapper around the `git` CLI.
//!
//! Security model:
//! * The webview can never pass raw git arguments. Every operation is a typed
//!   command whose arguments are validated here.
//! * git is spawned directly (no shell); refs/revisions can never start with
//!   `-` and paths are always passed after `--`, so nothing user-controlled is
//!   ever parsed as an option.
//! * The `ext::` transport is disabled and terminal prompts are off;
//!   credentials are handled only by the user's own git credential helper.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

pub type R<T> = Result<T, String>;

const MAX_DIFF_BYTES: usize = 2_000_000;
/// Diffs are always git's own: a repository's config may name an external diff program
/// (`diff.external`), and looking at a change must never run it.
const NO_EXT: &str = "--no-ext-diff";

pub struct Out {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

pub fn command(cwd: &Path) -> Command {
    let mut c = Command::new("git");
    c.current_dir(cwd)
        .args([
            "--no-pager",
            "-c",
            "core.quotepath=false",
            "-c",
            "color.ui=false",
            "-c",
            "protocol.ext.allow=never",
            "-c",
            "advice.detachedHead=false",
        ])
        .env("GIT_TERMINAL_PROMPT", "0")
        // Read-only commands must never grab index.lock and collide with a
        // terminal or an AI agent running git in the same repository.
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_EDITOR", "true")
        .env("GIT_SEQUENCE_EDITOR", "true")
        .env("GIT_MERGE_AUTOEDIT", "no")
        .env("LC_MESSAGES", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    c
}

pub fn exec(cwd: &Path, args: &[&str], input: Option<&[u8]>, envs: &[(&str, &str)]) -> R<Out> {
    let mut c = command(cwd);
    c.args(args);
    for (k, v) in envs {
        c.env(k, v);
    }
    if input.is_some() {
        c.stdin(Stdio::piped());
    }
    let mut child = c
        .spawn()
        .map_err(|e| format!("Could not start git (is it installed and on PATH?): {e}"))?;
    if let Some(data) = input {
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(data);
        }
    }
    let o = child.wait_with_output().map_err(|e| e.to_string())?;
    Ok(Out {
        code: o.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&o.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&o.stderr).into_owned(),
    })
}

fn fail(o: &Out) -> String {
    let e = o.stderr.trim();
    if !e.is_empty() {
        e.to_string()
    } else if !o.stdout.trim().is_empty() {
        o.stdout.trim().to_string()
    } else {
        format!("git exited with code {}", o.code)
    }
}

pub fn dir(repo: &str) -> R<PathBuf> {
    let p = PathBuf::from(repo);
    if !p.is_absolute() || !p.is_dir() {
        return Err(format!("Not a directory: {repo}"));
    }
    Ok(p)
}

/// Run and return stdout.
pub fn run(repo: &str, args: &[&str]) -> R<String> {
    let o = exec(&dir(repo)?, args, None, &[])?;
    if o.code == 0 {
        Ok(o.stdout)
    } else {
        Err(fail(&o))
    }
}

/// Run and return a human readable transcript (stdout + stderr).
fn run_msg(repo: &str, args: &[&str]) -> R<String> {
    let o = exec(&dir(repo)?, args, None, &[])?;
    if o.code == 0 {
        Ok(format!("{}\n{}", o.stdout.trim(), o.stderr.trim()).trim().to_string())
    } else {
        Err(fail(&o))
    }
}

/// Creates a file that must not exist yet (never follows a link someone left at that name).
fn new_file(path: &Path) -> R<std::fs::File> {
    std::fs::OpenOptions::new().write(true).create_new(true).open(path).map_err(|e| format!("Could not create a temporary file: {e}"))
}

/// Validate anything used as a ref / revision / remote name.
pub fn rf(s: &str) -> R<()> {
    if s.is_empty() || s.starts_with('-') || s.chars().any(|c| c.is_control()) || s.len() > 1024 {
        return Err(format!("Invalid name: {s:?}"));
    }
    Ok(())
}

fn hex(s: &str) -> R<()> {
    if s.len() < 4 || s.len() > 64 || !s.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(format!("Invalid commit id: {s:?}"));
    }
    Ok(())
}

fn paths_ok(paths: &[String]) -> R<()> {
    for p in paths {
        if p.is_empty() || p.contains('\0') {
            return Err("Invalid path".into());
        }
    }
    Ok(())
}

// ───────────────────────── repository ─────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    path: String,
    name: String,
}

fn info(top: &str) -> RepoInfo {
    let top = top.trim().to_string();
    let name = Path::new(&top)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| top.clone());
    RepoInfo { path: top, name }
}

#[tauri::command(async)]
pub fn repo_open(path: String) -> R<RepoInfo> {
    let top = run(&path, &["rev-parse", "--show-toplevel"])
        .map_err(|e| format!("Not a git repository.\n{e}"))?;
    Ok(info(&top))
}

// ───────────────────────── trust ─────────────────────────
//
// git lets a repository's own settings name programs to run: a file-watcher hook, content
// filters, a credential helper, an ssh command, hooks. A clone never copies those, but a
// folder that arrives with its .git directory (an archive, a shared drive) can carry them,
// and merely looking at such a repository would run them. So before anything else is run,
// the settings are read (reading runs nothing) and the user is asked once.

#[derive(Serialize, Debug, PartialEq)]
pub struct Risk {
    /// the setting ("core.fsmonitor") or "hook"
    what: String,
    /// its value, or the hook's name
    value: String,
    /// what it does, in plain words
    why: String,
}

#[derive(Serialize)]
pub struct RepoRisks {
    items: Vec<Risk>,
    /// changes whenever the list does, so a new setting is asked about again
    fingerprint: String,
}

/// Why a setting found in the repository's own config deserves a question, if it does.
fn risky(key: &str, value: &str) -> Option<&'static str> {
    let k = key.to_ascii_lowercase();
    let first = k.split('.').next().unwrap_or("");
    let last = k.rsplit('.').next().unwrap_or("");
    let v = value.trim().to_ascii_lowercase();
    let is_bool = matches!(v.as_str(), "" | "true" | "false" | "yes" | "no" | "on" | "off" | "1" | "0");
    Some(match (first, last) {
        ("core", "fsmonitor") if !is_bool => "runs this program every time the repository is looked at",
        ("core", "sshcommand" | "gitproxy" | "askpass" | "alternaterefscommand") => "runs this program when talking to a remote",
        ("core", "hookspath") => "runs the scripts in this folder on commit, checkout, push and more",
        ("credential", "helper") => "runs this program whenever a password or token is needed",
        ("diff", "external" | "textconv" | "command") => "runs this program when changes are shown",
        ("filter", "clean" | "smudge" | "process") => "runs this program on files as they are staged or checked out",
        ("merge", "driver") => "runs this program during merges",
        ("gpg", "program" | "defaultkeycommand") => "runs this program when commits are signed or verified",
        ("remote", "uploadpack" | "receivepack" | "vcs") => "runs this program on fetch or push",
        ("submodule", "update") if v.starts_with('!') => "runs this command when submodules are updated",
        ("include" | "includeif", "path") => "loads more settings from this file",
        ("http", "proxy") => "sends your connections through this proxy",
        ("http", "sslverify") if matches!(v.as_str(), "false" | "no" | "off" | "0") => "turns off checking the server's certificate",
        ("http", "sslcainfo" | "sslcapath") => "replaces the certificates used to check servers",
        _ => return None,
    })
}

/// What this repository's own settings and hooks would run. Runs nothing itself: it only
/// reads the config and lists the hooks folder.
#[tauri::command(async)]
pub fn repo_risks(repo: String) -> R<RepoRisks> {
    let mut items: Vec<Risk> = vec![];
    // --local is the repository's own file; --worktree is the per-worktree one, when in use.
    for scope in ["--local", "--worktree"] {
        let out = match run(&repo, &["config", scope, "--includes", "--list", "-z"]) {
            Ok(o) => o,
            Err(e) if scope == "--local" => return Err(e),
            Err(_) => continue,
        };
        for entry in out.split('\0').filter(|e| !e.is_empty()) {
            let (key, value) = entry.split_once('\n').unwrap_or((entry, ""));
            if let Some(why) = risky(key, value) {
                let r = Risk { what: key.to_string(), value: value.to_string(), why: why.to_string() };
                if !items.contains(&r) {
                    items.push(r);
                }
            }
        }
    }
    // Hooks: anything in the hooks folder that is not one of git's ".sample" files.
    if let Ok(h) = run(&repo, &["rev-parse", "--git-path", "hooks"]) {
        let hooks = dir(&repo)?.join(h.trim());
        let mut names: Vec<String> = std::fs::read_dir(&hooks)
            .map(|d| {
                d.filter_map(|e| e.ok())
                    .filter(|e| e.path().is_file())
                    .map(|e| e.file_name().to_string_lossy().into_owned())
                    .filter(|n| !n.ends_with(".sample"))
                    .collect()
            })
            .unwrap_or_default();
        names.sort();
        for n in names {
            items.push(Risk { what: "hook".into(), value: n, why: "a script git runs at that moment (commit, checkout, push...)".into() });
        }
    }
    // FNV-1a: stable across versions and platforms, which std's hasher does not promise.
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for r in &items {
        for b in r.what.bytes().chain([0]).chain(r.value.bytes()).chain([0]) {
            hash = (hash ^ b as u64).wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    Ok(RepoRisks { fingerprint: format!("{hash:016x}"), items })
}

#[tauri::command(async)]
pub fn repo_init(path: String) -> R<RepoInfo> {
    run(&path, &["init"])?;
    repo_open(path)
}

fn clone_url_ok(url: &str) -> bool {
    if url.starts_with('-') || url.chars().any(|c| c.is_control()) || url.contains("::") {
        return false;
    }
    if url.starts_with("https://") || url.starts_with("ssh://") {
        return true;
    }
    // scp-like: user@host:path
    if let Some((left, right)) = url.split_once(':') {
        if left.contains('@') && !left.contains('/') && !right.starts_with("//") {
            return true;
        }
    }
    Path::new(url).is_absolute() && Path::new(url).is_dir()
}

#[tauri::command(async)]
pub fn repo_clone(url: String, parent: String, name: String) -> R<RepoInfo> {
    let url = url.trim().to_string();
    if !clone_url_ok(&url) {
        return Err(
            "Unsupported clone URL. Use https://, ssh://, user@host:path or a local folder. Unencrypted http:// and git:// are blocked."
                .into(),
        );
    }
    let name = name.trim().to_string();
    if name.is_empty()
        || name.starts_with('.')
        || name.starts_with('-')
        || name.chars().any(|c| c.is_control() || "/\\:*?\"<>|".contains(c))
    {
        return Err("Invalid folder name".into());
    }
    let parent_dir = dir(&parent)?;
    let dest = parent_dir.join(&name);
    if dest.exists() {
        return Err(format!("{} already exists", dest.display()));
    }
    let dest_s = dest.to_string_lossy().into_owned();
    run(&parent, &["clone", "--", &url, &dest_s])?;
    repo_open(dest_s)
}

// ───────────────────────── status ─────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStatus {
    path: String,
    orig_path: Option<String>,
    /// index (staged) state: one of `.MTADRCU`
    x: String,
    /// worktree state
    y: String,
    /// tracked | untracked | conflict
    kind: String,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    head: String,
    branch: Option<String>,
    upstream: Option<String>,
    ahead: u32,
    behind: u32,
    files: Vec<FileStatus>,
    /// "", merge, rebase, cherry-pick, revert, bisect
    state: String,
}

#[tauri::command(async)]
pub fn get_status(repo: String) -> R<Status> {
    let out = run(
        &repo,
        &["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"],
    )?;
    let mut st = Status::default();
    let mut it = out.split('\0');
    while let Some(rec) = it.next() {
        if rec.is_empty() {
            continue;
        }
        if let Some(h) = rec.strip_prefix("# ") {
            if let Some(v) = h.strip_prefix("branch.oid ") {
                st.head = if v == "(initial)" { String::new() } else { v.to_string() };
            } else if let Some(v) = h.strip_prefix("branch.head ") {
                st.branch = if v == "(detached)" { None } else { Some(v.to_string()) };
            } else if let Some(v) = h.strip_prefix("branch.upstream ") {
                st.upstream = Some(v.to_string());
            } else if let Some(v) = h.strip_prefix("branch.ab ") {
                for part in v.split(' ') {
                    if let Some(n) = part.strip_prefix('+') {
                        st.ahead = n.parse().unwrap_or(0);
                    } else if let Some(n) = part.strip_prefix('-') {
                        st.behind = n.parse().unwrap_or(0);
                    }
                }
            }
            continue;
        }
        let tag = rec.as_bytes()[0];
        match tag {
            b'1' => {
                let f: Vec<&str> = rec.splitn(9, ' ').collect();
                if f.len() == 9 {
                    st.files.push(FileStatus {
                        path: f[8].to_string(),
                        orig_path: None,
                        x: f[1][0..1].to_string(),
                        y: f[1][1..2].to_string(),
                        kind: "tracked".into(),
                    });
                }
            }
            b'2' => {
                let f: Vec<&str> = rec.splitn(10, ' ').collect();
                let orig = it.next().map(|s| s.to_string());
                if f.len() == 10 {
                    st.files.push(FileStatus {
                        path: f[9].to_string(),
                        orig_path: orig,
                        x: f[1][0..1].to_string(),
                        y: f[1][1..2].to_string(),
                        kind: "tracked".into(),
                    });
                }
            }
            b'u' => {
                let f: Vec<&str> = rec.splitn(11, ' ').collect();
                if f.len() == 11 {
                    st.files.push(FileStatus {
                        path: f[10].to_string(),
                        orig_path: None,
                        x: f[1][0..1].to_string(),
                        y: f[1][1..2].to_string(),
                        kind: "conflict".into(),
                    });
                }
            }
            b'?' => st.files.push(FileStatus {
                path: rec[2..].to_string(),
                orig_path: None,
                x: ".".into(),
                y: "?".into(),
                kind: "untracked".into(),
            }),
            _ => {}
        }
    }
    let gd = run(&repo, &["rev-parse", "--absolute-git-dir"])?;
    let g = Path::new(gd.trim());
    st.state = if g.join("rebase-merge").exists() || g.join("rebase-apply").exists() {
        "rebase"
    } else if g.join("MERGE_HEAD").exists() {
        "merge"
    } else if g.join("CHERRY_PICK_HEAD").exists() {
        "cherry-pick"
    } else if g.join("REVERT_HEAD").exists() {
        "revert"
    } else if g.join("BISECT_LOG").exists() {
        "bisect"
    } else {
        ""
    }
    .to_string();
    Ok(st)
}

// ───────────────────────── log / refs ─────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    hash: String,
    parents: Vec<String>,
    author: String,
    email: String,
    time: i64,
    subject: String,
    refs: Vec<String>,
    /// `Co-authored-by` trailer values (how AI pair-programmers sign their work)
    coauthors: Vec<String>,
}

const LOG_FMT: &str = "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s%x1f%D%x1f%(trailers:key=Co-authored-by,valueonly,separator=%x2C)%x1e";

fn parse_log(out: &str) -> Vec<Commit> {
    out.split('\x1e')
        .filter_map(|rec| {
            let rec = rec.trim_start_matches(['\n', '\r']);
            let f: Vec<&str> = rec.split('\x1f').collect();
            if f.len() < 7 {
                return None;
            }
            Some(Commit {
                hash: f[0].to_string(),
                parents: f[1].split_whitespace().map(String::from).collect(),
                author: f[2].to_string(),
                email: f[3].to_string(),
                time: f[4].parse().unwrap_or(0),
                subject: f[5].to_string(),
                refs: f[6]
                    .split(", ")
                    .filter(|s| !s.is_empty())
                    .map(String::from)
                    .collect(),
                coauthors: f
                    .get(7)
                    .unwrap_or(&"")
                    .split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect(),
            })
        })
        .collect()
}

fn has_head(repo: &str) -> bool {
    run(repo, &["rev-parse", "--verify", "-q", "HEAD"]).is_ok()
}

#[tauri::command(async)]
pub fn get_log(repo: String, limit: u32, all: bool, path: Option<String>, mine: bool) -> R<Vec<Commit>> {
    if !has_head(&repo) && !all {
        return Ok(vec![]);
    }
    let n = limit.clamp(1, 200_000).to_string();
    let mut a = vec!["log", LOG_FMT, "--date-order", "--decorate=full", "-n", &n];
    if let Some(p) = &path {
        paths_ok(std::slice::from_ref(p))?;
        a.extend(["--follow", "--", p.as_str()]);
    } else if mine {
        // Only the branches whose newest commit is the user's, and what is checked out.
        let who = me(&repo);
        let refs = run(&repo, &["for-each-ref", "--format=%(refname)%1f%(authoremail)%1f%(authorname)", "refs/heads", "refs/remotes"])?;
        let mut revs = String::from("HEAD\n");
        for l in refs.lines() {
            let f: Vec<&str> = l.split('\x1f').collect();
            if f.len() == 3 && is_me(&who, f[1], f[2]) {
                revs.push_str(f[0]);
                revs.push('\n');
            }
        }
        a.push("--stdin");
        let o = exec(&dir(&repo)?, &a, Some(revs.as_bytes()), &[])?;
        return if o.code == 0 { Ok(parse_log(&o.stdout)) } else { Err(fail(&o)) };
    } else if all {
        a.extend(["--branches", "--remotes", "--tags", "HEAD"]);
        if !has_head(&repo) {
            a.pop();
        }
    }
    Ok(parse_log(&run(&repo, &a)?))
}

/// Who the user is in this repository: (email, name), lower-cased. Either may be empty.
fn me(repo: &str) -> (String, String) {
    let get = |k: &str| run(repo, &["config", "--get", k]).unwrap_or_default().trim().to_lowercase();
    (get("user.email"), get("user.name"))
}

/// `email` may come wrapped in angle brackets, as for-each-ref prints it.
fn is_me(me: &(String, String), email: &str, name: &str) -> bool {
    let email = email.trim_matches(|c| c == '<' || c == '>').to_lowercase();
    (!me.0.is_empty() && email == me.0) || (!me.1.is_empty() && name.to_lowercase() == me.1)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefInfo {
    name: String,
    short: String,
    /// head | remote | tag
    kind: String,
    hash: String,
    upstream: Option<String>,
    ahead: u32,
    behind: u32,
    gone: bool,
    is_head: bool,
    /// the newest commit on it was written by the user
    mine: bool,
    /// when that commit was made (unix seconds)
    time: i64,
}

#[tauri::command(async)]
pub fn get_refs(repo: String) -> R<Vec<RefInfo>> {
    let out = run(
        &repo,
        &[
            "for-each-ref",
            "--format=%(refname)%1f%(objectname)%1f%(upstream:short)%1f%(upstream:track,nobracket)%1f%(HEAD)%1f%(*objectname)%1f%(authoremail)%1f%(authorname)%1f%(creatordate:unix)",
            "refs/heads",
            "refs/remotes",
            "refs/tags",
        ],
    )?;
    let who = me(&repo);
    let mut v = vec![];
    for line in out.lines() {
        let f: Vec<&str> = line.split('\x1f').collect();
        if f.len() < 9 {
            continue;
        }
        let name = f[0];
        let (kind, short) = if let Some(s) = name.strip_prefix("refs/heads/") {
            ("head", s)
        } else if let Some(s) = name.strip_prefix("refs/remotes/") {
            ("remote", s)
        } else if let Some(s) = name.strip_prefix("refs/tags/") {
            ("tag", s)
        } else {
            continue;
        };
        if kind == "remote" && short.ends_with("/HEAD") {
            continue;
        }
        let mut ahead = 0;
        let mut behind = 0;
        for part in f[3].split(", ") {
            if let Some(n) = part.strip_prefix("ahead ") {
                ahead = n.parse().unwrap_or(0);
            } else if let Some(n) = part.strip_prefix("behind ") {
                behind = n.parse().unwrap_or(0);
            }
        }
        v.push(RefInfo {
            name: name.to_string(),
            short: short.to_string(),
            kind: kind.to_string(),
            // annotated tags: point at the commit, not the tag object
            hash: if f[5].is_empty() { f[1] } else { f[5] }.to_string(),
            upstream: if f[2].is_empty() { None } else { Some(f[2].to_string()) },
            ahead,
            behind,
            gone: f[3] == "gone",
            is_head: f[4] == "*",
            mine: kind != "tag" && is_me(&who, f[6], f[7]),
            time: f[8].parse().unwrap_or(0),
        });
    }
    Ok(v)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Remote {
    name: String,
    url: String,
}

#[tauri::command(async)]
pub fn get_remotes(repo: String) -> R<Vec<Remote>> {
    let out = run(&repo, &["remote"])?;
    let mut v = vec![];
    for name in out.lines().filter(|l| !l.is_empty()) {
        let url = run(&repo, &["remote", "get-url", "--", name]).unwrap_or_default();
        v.push(Remote { name: name.to_string(), url: redact_url(url.trim()) });
    }
    Ok(v)
}

/// Never hand embedded credentials (https://user:token@host/…) to the UI.
pub fn redact_url(url: &str) -> String {
    if let Some((scheme, rest)) = url.split_once("://") {
        if let Some((auth, tail)) = rest.split_once('@') {
            if !auth.contains('/') && auth.contains(':') {
                return format!("{scheme}://***@{tail}");
            }
        }
    }
    url.to_string()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stash {
    index: u32,
    hash: String,
    time: i64,
    message: String,
}

#[tauri::command(async)]
pub fn get_stashes(repo: String) -> R<Vec<Stash>> {
    let out = run(&repo, &["stash", "list", "--format=%H%x1f%at%x1f%gs"])?;
    Ok(out
        .lines()
        .enumerate()
        .filter_map(|(i, l)| {
            let f: Vec<&str> = l.split('\x1f').collect();
            if f.len() < 3 {
                return None;
            }
            Some(Stash {
                index: i as u32,
                hash: f[0].to_string(),
                time: f[1].parse().unwrap_or(0),
                message: f[2].to_string(),
            })
        })
        .collect())
}

// ───────────────────────── commit details / diff ─────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    status: String,
    path: String,
    old_path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetails {
    hash: String,
    parents: Vec<String>,
    author: String,
    email: String,
    time: i64,
    committer: String,
    committer_email: String,
    commit_time: i64,
    message: String,
    signature: String,
    files: Vec<ChangedFile>,
}

#[tauri::command(async)]
pub fn get_commit_details(repo: String, hash: String) -> R<CommitDetails> {
    hex(&hash)?;
    let meta = run(
        &repo,
        &[
            "show",
            "-s",
            "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ce%x1f%ct%x1f%G?%x1f%B",
            &hash,
        ],
    )?;
    let f: Vec<&str> = meta.splitn(10, '\x1f').collect();
    if f.len() < 10 {
        return Err("Could not read commit".into());
    }
    let names = run(
        &repo,
        &[
            "show",
            "--format=",
            "--name-status",
            "-z",
            "-M",
            "--diff-merges=first-parent",
            &hash,
        ],
    )?;
    let mut files = vec![];
    let mut it = names.split('\0');
    while let Some(s) = it.next() {
        let s = s.trim_start_matches('\n');
        if s.is_empty() {
            continue;
        }
        let code = s[0..1].to_string();
        if code == "R" || code == "C" {
            let old = it.next().unwrap_or("").to_string();
            let new = it.next().unwrap_or("").to_string();
            files.push(ChangedFile { status: code, path: new, old_path: Some(old) });
        } else if let Some(p) = it.next() {
            files.push(ChangedFile { status: code, path: p.to_string(), old_path: None });
        }
    }
    Ok(CommitDetails {
        hash: f[0].to_string(),
        parents: f[1].split_whitespace().map(String::from).collect(),
        author: f[2].to_string(),
        email: f[3].to_string(),
        time: f[4].parse().unwrap_or(0),
        committer: f[5].to_string(),
        committer_email: f[6].to_string(),
        commit_time: f[7].parse().unwrap_or(0),
        signature: f[8].to_string(),
        message: f[9].trim_end().to_string(),
        files,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffOut {
    text: String,
    truncated: bool,
}

#[tauri::command(async)]
pub fn get_diff(
    repo: String,
    kind: String,
    path: String,
    hash: Option<String>,
    old_path: Option<String>,
) -> R<DiffOut> {
    paths_ok(std::slice::from_ref(&path))?;
    let d = dir(&repo)?;
    let o = match kind.as_str() {
        "worktree" => exec(&d, &["diff", NO_EXT, "--", &path], None, &[])?,
        "staged" => exec(&d, &["diff", NO_EXT, "--cached", "-M", "--", &path], None, &[])?,
        "untracked" => {
            // --no-index reads any file it is given, so the path must stay inside the repository.
            inside(&repo, &path)?;
            let o = exec(&d, &["diff", NO_EXT, "--no-index", "--", "/dev/null", &path], None, &[])?;
            // --no-index exits 1 when there are differences
            Out { code: if o.code == 1 { 0 } else { o.code }, ..o }
        }
        "commit" => {
            let h = hash.ok_or("Missing commit id")?;
            hex(&h)?;
            let mut a = vec!["show", NO_EXT, "--format=", "--diff-merges=first-parent", "-M", &h, "--", &path];
            if let Some(op) = &old_path {
                paths_ok(std::slice::from_ref(op))?;
                a.push(op);
            }
            exec(&d, &a, None, &[])?
        }
        _ => return Err("Unknown diff kind".into()),
    };
    cap(o)
}

fn cap(o: Out) -> R<DiffOut> {
    if o.code != 0 {
        return Err(fail(&o));
    }
    let mut text = o.stdout;
    let truncated = text.len() > MAX_DIFF_BYTES;
    if truncated {
        let mut cut = MAX_DIFF_BYTES;
        while !text.is_char_boundary(cut) {
            cut -= 1;
        }
        text.truncate(cut);
    }
    Ok(DiffOut { text, truncated })
}

/// The complete multi-file patch for a commit, the index, or the working tree.
#[tauri::command(async)]
pub fn get_patch(repo: String, kind: String, hash: Option<String>) -> R<DiffOut> {
    let d = dir(&repo)?;
    let o = match kind.as_str() {
        "worktree" => exec(&d, &["diff", NO_EXT], None, &[])?,
        "staged" => exec(&d, &["diff", NO_EXT, "--cached", "-M"], None, &[])?,
        "commit" => {
            let h = hash.ok_or("Missing commit id")?;
            hex(&h)?;
            exec(&d, &["show", NO_EXT, "--format=", "--diff-merges=first-parent", "-M", &h], None, &[])?
        }
        _ => return Err("Unknown patch kind".into()),
    };
    cap(o)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    path: String,
    head: String,
    branch: Option<String>,
    current: bool,
}

#[tauri::command(async)]
pub fn get_worktrees(repo: String) -> R<Vec<Worktree>> {
    let out = run(&repo, &["worktree", "list", "--porcelain"])?;
    let here = run(&repo, &["rev-parse", "--show-toplevel"])?.trim().to_string();
    let mut v: Vec<Worktree> = vec![];
    for l in out.lines() {
        if let Some(p) = l.strip_prefix("worktree ") {
            v.push(Worktree { path: p.to_string(), head: String::new(), branch: None, current: p == here });
        } else if let Some(w) = v.last_mut() {
            if let Some(h) = l.strip_prefix("HEAD ") {
                w.head = h.to_string();
            } else if let Some(b) = l.strip_prefix("branch ") {
                w.branch = Some(b.strip_prefix("refs/heads/").unwrap_or(b).to_string());
            }
        }
    }
    Ok(v)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlameLine {
    hash: String,
    author: String,
    time: i64,
    summary: String,
    line: u32,
    text: String,
}

#[tauri::command(async)]
pub fn get_blame(repo: String, path: String, rev: Option<String>) -> R<Vec<BlameLine>> {
    paths_ok(std::slice::from_ref(&path))?;
    let mut a = vec!["blame", "--porcelain"];
    if let Some(r) = &rev {
        hex(r)?;
        a.push(r);
    }
    a.extend(["--", &path]);
    let out = run(&repo, &a)?;
    let mut meta: HashMap<String, (String, i64, String)> = HashMap::new();
    let mut lines = vec![];
    let mut cur = String::new();
    let mut cur_line = 0u32;
    let mut expect_header = true;
    for l in out.split('\n') {
        if expect_header {
            let mut p = l.split(' ');
            let h = p.next().unwrap_or("");
            if h.len() < 40 {
                continue;
            }
            cur = h.to_string();
            cur_line = p.nth(1).and_then(|n| n.parse().ok()).unwrap_or(0);
            meta.entry(cur.clone()).or_insert_with(|| (String::new(), 0, String::new()));
            expect_header = false;
        } else if let Some(t) = l.strip_prefix('\t') {
            let m = meta.get(&cur).cloned().unwrap_or_default();
            lines.push(BlameLine {
                hash: cur.clone(),
                author: m.0,
                time: m.1,
                summary: m.2,
                line: cur_line,
                text: t.trim_end_matches('\r').to_string(),
            });
            expect_header = true;
        } else if let Some(m) = meta.get_mut(&cur) {
            if let Some(v) = l.strip_prefix("author ") {
                m.0 = v.to_string();
            } else if let Some(v) = l.strip_prefix("author-time ") {
                m.1 = v.parse().unwrap_or(0);
            } else if let Some(v) = l.strip_prefix("summary ") {
                m.2 = v.to_string();
            }
        }
    }
    Ok(lines)
}

// ───────────────────────── safety net ─────────────────────────
//
// Every operation that can lose work first records what it is about to
// destroy under `refs/gitolotl/backup/*`. These are ordinary local refs: they
// are never pushed, they keep the objects alive through `git gc`, and they
// can be inspected or restored with plain git even without Gitolotl.
// If a snapshot cannot be taken the operation is refused (fail closed).

const BACKUP_PREFIX: &str = "refs/gitolotl/backup/";
const BACKUP_KEEP: usize = 200;

fn backup_name(label: &str) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    format!("{BACKUP_PREFIX}{:011}-{:09}-{label}", now.as_secs(), now.subsec_nanos())
}

fn prune_backups(repo: &str) {
    if let Ok(out) = run(repo, &["for-each-ref", "--format=%(refname)", BACKUP_PREFIX]) {
        let mut names: Vec<&str> = out.lines().filter(|l| l.starts_with(BACKUP_PREFIX)).collect();
        names.sort();
        let extra = names.len().saturating_sub(BACKUP_KEEP);
        for n in &names[..extra] {
            let _ = run(repo, &["update-ref", "-d", n]);
        }
    }
}

/// Records the commit `rev` points at, so a deleted branch / tag / stash or a
/// rewritten HEAD can always be found again. A missing rev is not an error.
fn backup_tip(repo: &str, label: &str, rev: &str) -> R<()> {
    let spec = format!("{rev}^{{commit}}");
    let Ok(hash) = run(repo, &["rev-parse", "--verify", "-q", &spec]) else {
        return Ok(());
    };
    run(repo, &["update-ref", &backup_name(label), hash.trim()])
        .map_err(|e| format!("Could not record a safety backup, so nothing was changed.\n{e}"))?;
    prune_backups(repo);
    Ok(())
}

/// Saves the complete working tree (tracked changes and untracked files, minus
/// ignored ones) as a commit, without touching the real index, the working
/// tree, HEAD or the stash. Returns `None` when there is nothing to save.
fn snapshot_worktree(repo: &str, label: &str) -> R<Option<String>> {
    let refuse = |e: String| format!("Could not take a safety snapshot, so nothing was changed.\n{e}");
    let d = dir(repo)?;
    let dirty = run(repo, &["status", "--porcelain", "--untracked-files=all"]).map_err(refuse)?;
    if dirty.trim().is_empty() {
        return Ok(None);
    }
    let index = run(repo, &["rev-parse", "--git-path", "index"]).map_err(refuse)?;
    let index = d.join(index.trim());
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let tmp = std::env::temp_dir().join(format!("gitolotl-index-{}-{}", std::process::id(), now.as_nanos()));
    if index.exists() {
        // Start from the real index so unchanged files are not re-hashed. The file is created
        // exclusively first, so a planted file or link at that name is never written through.
        new_file(&tmp).map_err(&refuse)?;
        std::fs::copy(&index, &tmp).map_err(|e| refuse(e.to_string()))?;
    }
    let tmp_s = tmp.to_string_lossy().into_owned();
    let envs = [
        ("GIT_INDEX_FILE", tmp_s.as_str()),
        ("GIT_AUTHOR_NAME", "Gitolotl"),
        ("GIT_AUTHOR_EMAIL", "snapshot@gitolotl.invalid"),
        ("GIT_COMMITTER_NAME", "Gitolotl"),
        ("GIT_COMMITTER_EMAIL", "snapshot@gitolotl.invalid"),
    ];
    let result = (|| -> R<String> {
        let step = |args: &[&str]| -> R<String> {
            let o = exec(&d, args, None, &envs)?;
            if o.code == 0 { Ok(o.stdout.trim().to_string()) } else { Err(fail(&o)) }
        };
        step(&["add", "-A"])?;
        let tree = step(&["write-tree"])?;
        let msg = format!("Gitolotl safety snapshot before {label}");
        let mut args = vec!["-c", "commit.gpgsign=false", "commit-tree", tree.as_str(), "-m", msg.as_str()];
        if has_head(repo) {
            args.extend(["-p", "HEAD"]);
        }
        let commit = step(&args)?;
        run(repo, &["update-ref", &backup_name(label), &commit])?;
        Ok(commit)
    })();
    let _ = std::fs::remove_file(&tmp);
    let commit = result.map_err(refuse)?;
    prune_backups(repo);
    Ok(Some(commit))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Backup {
    name: String,
    hash: String,
    time: i64,
    /// what was about to happen: discard, reset, delete-branch, …
    label: String,
    /// the branch / tag the action applied to, when that matters for undoing it
    detail: String,
    subject: String,
}

#[tauri::command(async)]
pub fn get_backups(repo: String) -> R<Vec<Backup>> {
    let out = run(
        &repo,
        &["for-each-ref", "--format=%(refname)%1f%(objectname)%1f%(subject)", BACKUP_PREFIX],
    )?;
    let mut v: Vec<Backup> = out
        .lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split('\x1f').collect();
            if f.len() < 3 {
                return None;
            }
            let rest = f[0].strip_prefix(BACKUP_PREFIX)?;
            let mut parts = rest.splitn(3, '-');
            let time = parts.next()?.parse().ok()?;
            let _nanos = parts.next()?;
            let (label, detail) = parts.next().unwrap_or("").split_once('/').unwrap_or((parts_label(rest), ""));
            Some(Backup {
                name: f[0].to_string(),
                hash: f[1].to_string(),
                time,
                label: label.to_string(),
                detail: detail.to_string(),
                subject: f[2].to_string(),
            })
        })
        .collect();
    v.sort_by(|a, b| b.name.cmp(&a.name));
    Ok(v)
}

fn parts_label(rest: &str) -> &str {
    rest.splitn(3, '-').nth(2).unwrap_or("")
}

/// Current branch name, or "" when HEAD is detached.
fn cur_branch(repo: &str) -> String {
    run(repo, &["symbolic-ref", "-q", "--short", "HEAD"]).unwrap_or_default().trim().to_string()
}

/// `label/<current branch>`, so an undo can refuse to move the wrong branch.
fn on_branch(repo: &str, label: &str) -> String {
    let b = cur_branch(repo);
    if b.is_empty() { label.to_string() } else { format!("{label}/{b}") }
}

/// Puts back the files a working-tree snapshot holds (only the files that
/// snapshot actually changed). The current state is snapshotted first, so an
/// undo can itself be undone.
fn restore_files(repo: &str, snap: &str) -> R<String> {
    let parent = format!("{snap}^");
    let names = run(repo, &["diff", "--name-only", "-z", "--no-renames", &parent, snap])?;
    let paths: Vec<String> = names.split('\0').filter(|p| !p.is_empty()).map(String::from).collect();
    if paths.is_empty() {
        return Ok("Nothing to restore".into());
    }
    snapshot_worktree(repo, "undo")?;
    let source = format!("--source={snap}");
    with_paths(repo, &["restore", &source, "--worktree"], &paths)?;
    Ok(format!("Restored {} file{}", paths.len(), if paths.len() == 1 { "" } else { "s" }))
}

/// Moves the current branch back to `target`. Never discards local changes:
/// `--keep` refuses when they would be overwritten, and the fallback only
/// moves HEAD and the index.
fn move_branch(repo: &str, target: &str, expect_branch: &str, soft: bool) -> R<String> {
    let now = cur_branch(repo);
    if !expect_branch.is_empty() && now != expect_branch {
        return Err(format!("This change was made on '{expect_branch}'. Check that branch out first, then undo."));
    }
    backup_tip(repo, &on_branch(repo, "undo-move"), "HEAD")?;
    if soft {
        return run_msg(repo, &["reset", "--soft", target, "--"]);
    }
    match run_msg(repo, &["reset", "--keep", target, "--"]) {
        Ok(m) => Ok(m),
        Err(_) => run_msg(repo, &["reset", "--mixed", "-q", target, "--"]),
    }
}

/// Undoes the action a backup was taken for.
#[tauri::command(async)]
pub fn restore_backup(repo: String, name: String) -> R<String> {
    let b = get_backups(repo.clone())?
        .into_iter()
        .find(|b| b.name == name)
        .ok_or("That safety snapshot no longer exists")?;
    let h = b.hash.as_str();
    match b.label.as_str() {
        "discard" | "discard-hunk" | "abort" | "resolve-conflict" | "rebase-skip" | "undo" | "merge-edit" | "manual" => {
            restore_files(&repo, h)
        }
        "reset-hard" => {
            move_branch(&repo, &format!("{h}^"), "", false)?;
            restore_files(&repo, h)
        }
        "amend" => move_branch(&repo, h, &b.detail, true),
        "reset" | "rebase" | "interactive-rebase" | "undo-move" => move_branch(&repo, h, &b.detail, false),
        "delete-branch" => {
            rf(&b.detail)?;
            run_msg(&repo, &["branch", "--", &b.detail, h]).map(|_| format!("Restored branch {}", b.detail))
        }
        "delete-remote-branch" => {
            let local = b.detail.split_once('/').map(|x| x.1).unwrap_or(&b.detail).to_string();
            rf(&local)?;
            run_msg(&repo, &["branch", "--", &local, h])
                .map(|_| format!("Restored as local branch {local}. Push it to put it back on the remote."))
        }
        "delete-tag" => {
            rf(&b.detail)?;
            run_msg(&repo, &["tag", "--", &b.detail, h]).map(|_| format!("Restored tag {}", b.detail))
        }
        "drop-stash" => run_msg(&repo, &["stash", "store", "-m", "Restored by Gitolotl", h]).map(|_| "Stash restored".into()),
        other => Err(format!("Don't know how to undo '{other}'. Create a branch from the snapshot instead.")),
    }
}

/// Lets a script or an AI agent take a safety snapshot before it starts work.
pub fn snapshot_now(repo: &str) -> R<Option<String>> {
    let top = run(repo, &["rev-parse", "--show-toplevel"])?;
    snapshot_worktree(top.trim(), "manual")
}

#[tauri::command(async)]
pub fn delete_backup(repo: String, name: String) -> R<()> {
    if !name.starts_with(BACKUP_PREFIX) || name.contains("..") || name.chars().any(|c| c.is_control() || c == ' ') {
        return Err("Not a Gitolotl backup".into());
    }
    run(&repo, &["update-ref", "-d", &name]).map(|_| ())
}

// ───────────────────────── merge editor ─────────────────────────

fn unmerged(repo: &str) -> R<Vec<String>> {
    Ok(run(repo, &["diff", "--name-only", "--diff-filter=U", "-z"])?
        .split('\0')
        .filter(|p| !p.is_empty())
        .map(String::from)
        .collect())
}

/// Resolves a repo-relative path, refusing anything that could leave the repository.
fn inside(repo: &str, rel: &str) -> R<PathBuf> {
    use std::path::Component;
    let p = Path::new(rel);
    if rel.is_empty() || !p.components().all(|c| matches!(c, Component::Normal(_))) {
        return Err("Invalid path".into());
    }
    let root = dir(repo)?;
    let full = root.join(p);
    // A symlinked folder on the way must not lead out of the repository either.
    let real_root = root.canonicalize().map_err(|e| e.to_string())?;
    let parent = full.parent().unwrap_or(&root).canonicalize().map_err(|e| e.to_string())?;
    if !parent.starts_with(&real_root) {
        return Err("This path leads outside the repository".into());
    }
    Ok(full)
}

/// Like `inside`, for a file whose contents the app itself reads or writes: a symlink is
/// refused, because reading or writing it would act on whatever it points at.
fn inside_file(repo: &str, rel: &str) -> R<PathBuf> {
    let full = inside(repo, rel)?;
    if std::fs::symlink_metadata(&full).map(|m| m.file_type().is_symlink()).unwrap_or(false) {
        return Err("This is a symbolic link, not a text file. Resolve it with 'ours' or 'theirs'.".into());
    }
    Ok(full)
}

/// The working-tree text of a conflicted file, conflict markers included.
#[tauri::command(async)]
pub fn get_conflict(repo: String, path: String) -> R<String> {
    if !unmerged(&repo)?.contains(&path) {
        return Err("This file is not in conflict".into());
    }
    let bytes = std::fs::read(inside_file(&repo, &path)?).map_err(|e| e.to_string())?;
    if bytes.len() > MAX_DIFF_BYTES || bytes.contains(&0) {
        return Err("This file is binary or too large for the merge editor. Use 'Resolve using ours / theirs' or your own editor.".into());
    }
    String::from_utf8(bytes).map_err(|_| "This file is not UTF-8 text. Resolve it in your own editor.".to_string())
}

/// Writes the resolved text of a conflicted file and marks it resolved.
#[tauri::command(async)]
pub fn resolve_with_content(repo: String, path: String, content: String) -> R<()> {
    if !unmerged(&repo)?.contains(&path) {
        return Err("This file is not in conflict".into());
    }
    let file = inside_file(&repo, &path)?;
    snapshot_worktree(&repo, "merge-edit")?;
    std::fs::write(&file, content).map_err(|e| e.to_string())?;
    with_paths(&repo, &["add"], &[path]).map(|_| ())
}

// ───────────────────────── worktrees ─────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeDetail {
    path: String,
    branch: Option<String>,
    head: String,
    current: bool,
    missing: bool,
    dirty: u32,
    ahead: u32,
    behind: u32,
    has_upstream: bool,
    last: Option<Commit>,
}

/// One row per worktree with what you need to supervise parallel work.
#[tauri::command(async)]
pub fn get_worktree_details(repo: String) -> R<Vec<WorktreeDetail>> {
    let mut out = vec![];
    for w in get_worktrees(repo)? {
        let exists = Path::new(&w.path).is_dir();
        let mut d = WorktreeDetail {
            path: w.path.clone(),
            branch: w.branch,
            head: w.head,
            current: w.current,
            missing: !exists,
            dirty: 0,
            ahead: 0,
            behind: 0,
            has_upstream: false,
            last: None,
        };
        if exists {
            if let Ok(s) = run(&w.path, &["status", "--porcelain", "--untracked-files=all"]) {
                d.dirty = s.lines().filter(|l| !l.is_empty()).count() as u32;
            }
            if let Ok(c) = run(&w.path, &["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]) {
                let mut n = c.split_whitespace().map(|x| x.parse().unwrap_or(0));
                d.behind = n.next().unwrap_or(0);
                d.ahead = n.next().unwrap_or(0);
                d.has_upstream = true;
            }
            if let Ok(l) = run(&w.path, &["log", "-1", LOG_FMT, "--decorate=full"]) {
                d.last = parse_log(&l).into_iter().next();
            }
        }
        out.push(d);
    }
    Ok(out)
}

#[tauri::command(async)]
pub fn add_worktree(repo: String, path: String, branch: String, create: bool) -> R<String> {
    rf(&branch)?;
    let p = PathBuf::from(&path);
    if !p.is_absolute() || p.exists() || !p.parent().map(|x| x.is_dir()).unwrap_or(false) {
        return Err("Choose a new folder name inside an existing folder".into());
    }
    if create {
        run_msg(&repo, &["worktree", "add", "-b", &branch, "--", &path])
    } else {
        run_msg(&repo, &["worktree", "add", "--", &path, &branch])
    }
}

/// Removes a worktree. Never forced: git refuses if it has uncommitted or untracked files.
#[tauri::command(async)]
pub fn remove_worktree(repo: String, path: String) -> R<String> {
    let known = get_worktrees(repo.clone())?;
    match known.iter().find(|w| w.path == path) {
        None => Err("Not a worktree of this repository".into()),
        Some(w) if w.current => Err("Cannot remove the worktree you are in".into()),
        Some(_) => run_msg(&repo, &["worktree", "remove", "--", &path]),
    }
}

/// Commits a push would publish (newest first).
#[tauri::command(async)]
pub fn get_unpushed(repo: String) -> R<Vec<String>> {
    let out = run(&repo, &["rev-list", "--max-count=2000", "@{upstream}..HEAD"])
        .or_else(|_| run(&repo, &["rev-list", "--max-count=2000", "HEAD", "--not", "--remotes"]))
        .unwrap_or_default();
    Ok(out.lines().filter(|l| !l.is_empty()).map(String::from).collect())
}

// ───────────────────────── staging / committing ─────────────────────────

fn with_paths(repo: &str, head: &[&str], paths: &[String]) -> R<String> {
    paths_ok(paths)?;
    if paths.is_empty() {
        return Ok(String::new());
    }
    let mut out = String::new();
    // chunk to stay below OS command-line limits
    for chunk in paths.chunks(200) {
        let mut a: Vec<&str> = head.to_vec();
        a.push("--");
        a.extend(chunk.iter().map(|s| s.as_str()));
        out.push_str(&run(repo, &a)?);
    }
    Ok(out)
}

#[tauri::command(async)]
pub fn stage(repo: String, paths: Vec<String>) -> R<()> {
    with_paths(&repo, &["add", "-A"], &paths).map(|_| ())
}

#[tauri::command(async)]
pub fn stage_all(repo: String) -> R<()> {
    run(&repo, &["add", "-A"]).map(|_| ())
}

#[tauri::command(async)]
pub fn unstage(repo: String, paths: Vec<String>) -> R<()> {
    with_paths(&repo, &["reset", "-q"], &paths).map(|_| ())
}

#[tauri::command(async)]
pub fn unstage_all(repo: String) -> R<()> {
    run(&repo, &["reset", "-q"]).map(|_| ())
}

#[tauri::command(async)]
pub fn discard(repo: String, tracked: Vec<String>, untracked: Vec<String>) -> R<()> {
    paths_ok(&tracked)?;
    paths_ok(&untracked)?;
    snapshot_worktree(&repo, "discard")?;
    with_paths(&repo, &["restore", "--worktree"], &tracked)?;
    with_paths(&repo, &["clean", "-f", "-d"], &untracked)?;
    Ok(())
}

#[tauri::command(async)]
pub fn apply_patch(repo: String, patch: String, cached: bool, reverse: bool) -> R<()> {
    if !cached {
        // applying to the working tree rewrites files on disk
        snapshot_worktree(&repo, "discard-hunk")?;
    }
    let mut a = vec!["apply", "--whitespace=nowarn"];
    if cached {
        a.push("--cached");
    }
    if reverse {
        a.push("--reverse");
    }
    a.push("-");
    let o = exec(&dir(&repo)?, &a, Some(patch.as_bytes()), &[])?;
    if o.code == 0 {
        Ok(())
    } else {
        Err(fail(&o))
    }
}

#[tauri::command(async)]
pub fn commit(repo: String, message: String, amend: bool, signoff: bool) -> R<String> {
    if message.trim().is_empty() {
        return Err("Commit message is empty".into());
    }
    if amend {
        backup_tip(&repo, &on_branch(&repo, "amend"), "HEAD")?;
    }
    let mut a = vec!["commit", "-F", "-", "--cleanup=strip"];
    if amend {
        a.push("--amend");
    }
    if signoff {
        a.push("--signoff");
    }
    let o = exec(&dir(&repo)?, &a, Some(message.as_bytes()), &[])?;
    if o.code == 0 {
        Ok(o.stdout.trim().to_string())
    } else {
        Err(fail(&o))
    }
}

#[tauri::command(async)]
pub fn last_commit_message(repo: String) -> R<String> {
    Ok(run(&repo, &["log", "-1", "--format=%B"])?.trim_end().to_string())
}

#[tauri::command(async)]
pub fn resolve_conflict(repo: String, path: String, side: String) -> R<()> {
    let flag = match side.as_str() {
        "ours" => "--ours",
        "theirs" => "--theirs",
        _ => return Err("Invalid side".into()),
    };
    let p = vec![path];
    paths_ok(&p)?;
    snapshot_worktree(&repo, "resolve-conflict")?;
    with_paths(&repo, &["checkout", flag], &p)?;
    with_paths(&repo, &["add"], &p)?;
    Ok(())
}

// ───────────────────────── branches / tags ─────────────────────────

#[tauri::command(async)]
pub fn checkout(repo: String, target: String, kind: String) -> R<String> {
    rf(&target)?;
    match kind.as_str() {
        "head" => run_msg(&repo, &["checkout", &target, "--"]),
        "remote" => {
            let local = target.split_once('/').map(|x| x.1).unwrap_or(&target).to_string();
            rf(&local)?;
            let full = format!("refs/heads/{local}");
            if run(&repo, &["show-ref", "--verify", "-q", &full]).is_ok() {
                run_msg(&repo, &["checkout", &local, "--"])
            } else {
                run_msg(&repo, &["checkout", "-b", &local, "--track", &target])
            }
        }
        _ => run_msg(&repo, &["checkout", "--detach", &target, "--"]),
    }
}

/// The default branch of the `origin` remote, as "origin/main". None when there is no such remote
/// or it has never told us (a repository that was not cloned).
#[tauri::command(async)]
pub fn default_branch(repo: String) -> R<Option<String>> {
    Ok(run(&repo, &["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty()))
}

/// Create a branch, optionally from another starting point, and optionally switch to it.
///
/// `changes` says what happens to uncommitted work when switching:
/// - "bring" (the default): it comes along. git refuses, changing nothing, if it cannot.
/// - "leave": it is stashed first, so it stays behind with the branch it was made on.
///
/// The new branch never tracks its starting point: a branch cut from origin/main is not
/// main, and must not push there.
#[tauri::command(async)]
pub fn create_branch(repo: String, name: String, start: Option<String>, checkout: bool, changes: Option<String>) -> R<String> {
    rf(&name)?;
    if let Some(s) = &start {
        rf(s)?;
    }
    let leave = match changes.as_deref() {
        None | Some("bring") => false,
        Some("leave") => true,
        Some(other) => return Err(format!("Invalid option: {other:?}")),
    };
    // ...unless it is that branch: "fix-1" made from origin/fix-1 is the local copy of it.
    let same = start.as_deref().is_some_and(|s| {
        s.split_once('/').is_some_and(|(_, b)| b == name) && run(&repo, &["show-ref", "--verify", "-q", &format!("refs/remotes/{s}")]).is_ok()
    });
    let track = if same { "--track" } else { "--no-track" };
    if !checkout {
        let mut a = vec!["branch", track, name.as_str()];
        a.extend(start.as_deref());
        return run_msg(&repo, &a);
    }
    let mut a = vec!["checkout", track, "-b", name.as_str()];
    a.extend(start.as_deref());

    let dirty = !run(&repo, &["status", "--porcelain", "--untracked-files=all"])?.trim().is_empty();
    if !(leave && dirty) {
        return run_msg(&repo, &a).map_err(|e| {
            if e.contains("would be overwritten") {
                format!("Your uncommitted changes cannot be brought along: they touch files that differ on the starting point. Nothing was changed. Commit them, or choose to leave them behind.\n\n{e}")
            } else {
                e
            }
        });
    }

    // Leave the work behind: stash it, labelled with where it came from.
    let from = run(&repo, &["rev-parse", "--abbrev-ref", "HEAD"]).map(|s| s.trim().to_string()).unwrap_or_default();
    let from = if from.is_empty() || from == "HEAD" { "the previous commit".to_string() } else { from };
    let stash_tip = |repo: &str| run(repo, &["rev-parse", "-q", "--verify", "refs/stash"]).map(|s| s.trim().to_string()).unwrap_or_default();
    let before = stash_tip(&repo);
    let label = format!("Left on {from} when creating {name}");
    run_msg(&repo, &["stash", "push", "--include-untracked", "-m", &label])?;
    let after = stash_tip(&repo);
    if after.is_empty() || after == before {
        return Err("Could not set your uncommitted changes aside, so the branch was not created. Nothing was changed.".into());
    }
    match run_msg(&repo, &a) {
        Ok(m) => Ok(format!("{m}\nYour uncommitted changes stayed behind as a stash: \"{label}\".")),
        Err(e) => {
            // Put the work back exactly as it was. Only ever pop the stash we just made.
            if stash_tip(&repo) == after && run_msg(&repo, &["stash", "pop", "--index"]).is_ok() {
                Err(e)
            } else {
                Err(format!("{e}\n\nYour uncommitted changes are safe in the newest stash: \"{label}\"."))
            }
        }
    }
}

/// Local branches with nothing that `into` does not already have: deleting one loses no commits.
#[tauri::command(async)]
pub fn merged_branches(repo: String, into: String) -> R<Vec<String>> {
    rf(&into)?;
    let out = run(&repo, &["for-each-ref", "--format=%(refname)", &format!("--merged={into}"), "refs/heads"])?;
    Ok(out.lines().filter_map(|l| l.strip_prefix("refs/heads/")).map(str::to_string).collect())
}

#[tauri::command(async)]
pub fn delete_branch(repo: String, name: String, force: bool) -> R<String> {
    rf(&name)?;
    backup_tip(&repo, &format!("delete-branch/{name}"), &format!("refs/heads/{name}"))?;
    run_msg(&repo, &["branch", if force { "-D" } else { "-d" }, "--", &name])
}

#[tauri::command(async)]
pub fn rename_branch(repo: String, old: String, new: String) -> R<String> {
    rf(&old)?;
    rf(&new)?;
    run_msg(&repo, &["branch", "-m", "--", &old, &new])
}

#[tauri::command(async)]
pub fn delete_remote_branch(repo: String, remote: String, name: String) -> R<String> {
    rf(&remote)?;
    rf(&name)?;
    backup_tip(&repo, &format!("delete-remote-branch/{remote}/{name}"), &format!("refs/remotes/{remote}/{name}"))?;
    run_msg(&repo, &["push", "--delete", "--", &remote, &name])
}

#[tauri::command(async)]
pub fn create_tag(repo: String, name: String, target: Option<String>, message: Option<String>) -> R<String> {
    rf(&name)?;
    let mut a = vec!["tag"];
    let msg = message.unwrap_or_default();
    if !msg.trim().is_empty() {
        a.extend(["-a", "-m", msg.as_str()]);
    }
    a.extend(["--", name.as_str()]);
    if let Some(t) = &target {
        rf(t)?;
        a.push(t);
    }
    run_msg(&repo, &a)
}

#[tauri::command(async)]
pub fn delete_tag(repo: String, name: String) -> R<String> {
    rf(&name)?;
    backup_tip(&repo, &format!("delete-tag/{name}"), &format!("refs/tags/{name}"))?;
    run_msg(&repo, &["tag", "-d", "--", &name])
}

// ───────────────────────── history rewriting ─────────────────────────

#[tauri::command(async)]
pub fn merge(repo: String, target: String, mode: String) -> R<String> {
    rf(&target)?;
    let flag = match mode.as_str() {
        "ff-only" => "--ff-only",
        "no-ff" => "--no-ff",
        "squash" => "--squash",
        _ => "--ff",
    };
    run_msg(&repo, &["merge", "--no-edit", flag, &target])
}

#[tauri::command(async)]
pub fn rebase(repo: String, onto: String) -> R<String> {
    rf(&onto)?;
    backup_tip(&repo, &on_branch(&repo, "rebase"), "HEAD")?;
    run_msg(&repo, &["rebase", &onto])
}

#[tauri::command(async)]
pub fn cherry_pick(repo: String, hash: String) -> R<String> {
    hex(&hash)?;
    run_msg(&repo, &["cherry-pick", &hash])
}

#[tauri::command(async)]
pub fn revert(repo: String, hash: String) -> R<String> {
    hex(&hash)?;
    run_msg(&repo, &["revert", "--no-edit", &hash])
}

#[tauri::command(async)]
pub fn reset(repo: String, target: String, mode: String) -> R<String> {
    rf(&target)?;
    let flag = match mode.as_str() {
        "soft" => "--soft",
        "hard" => "--hard",
        _ => "--mixed",
    };
    backup_tip(&repo, &on_branch(&repo, "reset"), "HEAD")?;
    if flag == "--hard" {
        snapshot_worktree(&repo, "reset-hard")?;
    }
    run_msg(&repo, &["reset", flag, &target, "--"])
}

#[tauri::command(async)]
pub fn op_continue(repo: String, state: String) -> R<String> {
    match state.as_str() {
        "merge" => run_msg(&repo, &["commit", "--no-edit"]),
        "rebase" => run_msg(&repo, &["rebase", "--continue"]),
        "cherry-pick" => run_msg(&repo, &["cherry-pick", "--continue"]),
        "revert" => run_msg(&repo, &["revert", "--continue"]),
        _ => Err("Nothing to continue".into()),
    }
}

#[tauri::command(async)]
pub fn op_abort(repo: String, state: String) -> R<String> {
    // aborting throws away any conflict resolution done so far
    snapshot_worktree(&repo, "abort")?;
    match state.as_str() {
        "merge" => run_msg(&repo, &["merge", "--abort"]),
        "rebase" => run_msg(&repo, &["rebase", "--abort"]),
        "cherry-pick" => run_msg(&repo, &["cherry-pick", "--abort"]),
        "revert" => run_msg(&repo, &["revert", "--abort"]),
        "bisect" => run_msg(&repo, &["bisect", "reset"]),
        _ => Err("Nothing to abort".into()),
    }
}

#[tauri::command(async)]
pub fn op_skip(repo: String) -> R<String> {
    snapshot_worktree(&repo, "rebase-skip")?;
    run_msg(&repo, &["rebase", "--skip"])
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoCommit {
    hash: String,
    subject: String,
    merge: bool,
}

/// Commits that an interactive rebase starting at `from` (inclusive) would replay, oldest first.
#[tauri::command(async)]
pub fn rebase_candidates(repo: String, from: String) -> R<Vec<TodoCommit>> {
    hex(&from)?;
    let has_parent = run(&repo, &["rev-parse", "--verify", "-q", &format!("{from}^")]).is_ok();
    let range = if has_parent { format!("{from}^..HEAD") } else { "HEAD".to_string() };
    let out = run(&repo, &["log", "--reverse", "--format=%H%x1f%P%x1f%s", &range])?;
    Ok(out
        .lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split('\x1f').collect();
            (f.len() == 3).then(|| TodoCommit {
                hash: f[0].to_string(),
                merge: f[1].contains(' '),
                subject: f[2].to_string(),
            })
        })
        .collect())
}

#[derive(Deserialize)]
pub struct TodoItem {
    action: String,
    hash: String,
}

#[tauri::command(async)]
pub fn rebase_interactive(repo: String, from: String, todo: Vec<TodoItem>) -> R<String> {
    hex(&from)?;
    let mut text = String::new();
    for t in &todo {
        hex(&t.hash)?;
        if !matches!(t.action.as_str(), "pick" | "squash" | "fixup" | "drop") {
            return Err("Invalid rebase action".into());
        }
        text.push_str(&format!("{} {}\n", t.action, t.hash));
    }
    if !todo.iter().any(|t| t.action != "drop") {
        return Err("At least one commit must be kept".into());
    }
    backup_tip(&repo, &on_branch(&repo, "interactive-rebase"), "HEAD")?;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let file = std::env::temp_dir().join(format!("gitolotl-todo-{}-{nanos}.txt", std::process::id()));
    new_file(&file)?.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
    let file_s = file.to_string_lossy().replace('\\', "/");
    let has_parent = run(&repo, &["rev-parse", "--verify", "-q", &format!("{from}^")]).is_ok();
    let base = format!("{from}^");
    let args: Vec<&str> = if has_parent {
        vec!["rebase", "-i", &base]
    } else {
        vec!["rebase", "-i", "--root"]
    };
    // The todo path travels in an env var, so nothing needs shell quoting.
    let o = exec(
        &dir(&repo)?,
        &args,
        None,
        &[
            ("GITOLOTL_TODO", file_s.as_str()),
            ("GIT_SEQUENCE_EDITOR", "sh -c 'cat \"$GITOLOTL_TODO\" > \"$1\"' --"),
        ],
    );
    let _ = std::fs::remove_file(&file);
    let o = o?;
    if o.code == 0 {
        Ok(format!("{}\n{}", o.stdout.trim(), o.stderr.trim()).trim().to_string())
    } else {
        Err(fail(&o))
    }
}

// ───────────────────────── remotes ─────────────────────────

#[tauri::command(async)]
pub fn fetch(repo: String) -> R<String> {
    run_msg(&repo, &["fetch", "--all", "--prune", "--tags"])
}

#[tauri::command(async)]
pub fn pull(repo: String, mode: String) -> R<String> {
    let flag = match mode.as_str() {
        "rebase" => "--rebase",
        "ff-only" => "--ff-only",
        _ => "--no-rebase",
    };
    dir(&repo)?;
    if run(&repo, &["rev-parse", "-q", "--verify", "@{upstream}"]).is_ok() {
        return run_msg(&repo, &["pull", flag]);
    }

    // No usable upstream. git's own answer is a wall of text about tracking information;
    // work out what the user means instead.
    let branch = run(&repo, &["symbolic-ref", "--short", "-q", "HEAD"]).map(|s| s.trim().to_string()).unwrap_or_default();
    if branch.is_empty() {
        return Err("You are not on a branch, so there is nothing to pull into. Check out a branch first.".into());
    }
    let remotes: Vec<String> = run(&repo, &["remote"])?.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect();
    if remotes.is_empty() {
        return Err("This repository has no remote to pull from.".into());
    }
    run_msg(&repo, &["fetch", "--all", "--prune", "--tags"])?;
    // A branch that tracks something which is gone keeps its setting: that is not ours to rewrite.
    if let Ok(was) = run(&repo, &["config", "--get", &format!("branch.{branch}.merge")]) {
        let was = was.trim().trim_start_matches("refs/heads/");
        return Err(format!("{branch} tracks \"{was}\", which no longer exists on the remote. Nothing was changed. Push to publish it again."));
    }
    // The same name on a remote is the same branch: pull that, and remember it.
    let has = |r: &str| run(&repo, &["show-ref", "--verify", "-q", &format!("refs/remotes/{r}/{branch}")]).is_ok();
    let found: Vec<&String> = remotes.iter().filter(|r| has(r)).collect();
    let remote = match found.iter().find(|r| r.as_str() == "origin").or(found.first()) {
        Some(r) if found.len() == 1 || r.as_str() == "origin" => r.as_str(),
        Some(_) => return Err(format!("{branch} exists on more than one remote. Check out the one you mean from the Remote list.")),
        None => return Ok(format!("Nothing to pull: {branch} has not been pushed yet. Push to publish it.")),
    };
    let up = format!("{remote}/{branch}");
    run_msg(&repo, &["branch", &format!("--set-upstream-to={up}")])?;
    let out = run_msg(&repo, &["pull", flag])?;
    Ok(format!("{branch} now tracks {up}.\n{out}").trim().to_string())
}

#[tauri::command(async)]
pub fn push(
    repo: String,
    remote: Option<String>,
    branch: Option<String>,
    force: bool,
    set_upstream: bool,
    tags: bool,
) -> R<String> {
    let mut a = vec!["push"];
    if force {
        // Refuses to overwrite remote commits we have not seen *and integrated*.
        a.push("--force-with-lease");
        a.push("--force-if-includes");
    }
    if set_upstream {
        a.push("--set-upstream");
    }
    if tags {
        a.push("--tags");
    }
    if let Some(r) = &remote {
        rf(r)?;
        a.push(r);
        if let Some(b) = &branch {
            rf(b)?;
            a.push(b);
        }
    }
    run_msg(&repo, &a)
}

#[tauri::command(async)]
pub fn add_remote(repo: String, name: String, url: String) -> R<String> {
    rf(&name)?;
    let url = url.trim().to_string();
    if !clone_url_ok(&url) {
        return Err("Unsupported remote URL (use https://, ssh:// or user@host:path)".into());
    }
    run_msg(&repo, &["remote", "add", "--", &name, &url])
}

#[tauri::command(async)]
pub fn remove_remote(repo: String, name: String) -> R<String> {
    rf(&name)?;
    run_msg(&repo, &["remote", "remove", "--", &name])
}

// ───────────────────────── stash ─────────────────────────

#[tauri::command(async)]
pub fn stash_push(repo: String, message: String, include_untracked: bool) -> R<String> {
    let mut a = vec!["stash", "push"];
    if include_untracked {
        a.push("--include-untracked");
    }
    let m = message.trim().to_string();
    if !m.is_empty() {
        a.extend(["-m", m.as_str()]);
    }
    run_msg(&repo, &a)
}

#[tauri::command(async)]
pub fn stash_op(repo: String, op: String, index: u32, hash: Option<String>) -> R<String> {
    let op = match op.as_str() {
        "apply" => "apply",
        "pop" => "pop",
        "drop" => "drop",
        _ => return Err("Invalid stash operation".into()),
    };
    let stash = format!("stash@{{{index}}}");
    // Stashes are numbered from the newest, so a number goes stale when the list changes.
    // A caller that knows which stash it means says so, and anything else is refused.
    if let Some(h) = &hash {
        hex(h)?;
        if run(&repo, &["rev-parse", "--verify", "-q", &stash]).unwrap_or_default().trim() != h {
            return Err("The list of stashes has changed, so nothing was done. Refresh and try again.".into());
        }
    }
    if op == "drop" {
        backup_tip(&repo, "drop-stash", &stash)?;
    }
    run_msg(&repo, &["stash", op, &stash])
}

// ───────────────────────── config ─────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    name: String,
    email: String,
    git_version: String,
}

#[tauri::command(async)]
pub fn get_identity(repo: String) -> R<Identity> {
    let get = |k: &str| run(&repo, &["config", "--get", k]).unwrap_or_default().trim().to_string();
    Ok(Identity {
        name: get("user.name"),
        email: get("user.email"),
        git_version: run(&repo, &["--version"]).unwrap_or_default().trim().to_string(),
    })
}

#[tauri::command(async)]
pub fn set_identity(repo: String, name: String, email: String, global: bool) -> R<()> {
    if name.chars().any(|c| c.is_control()) || email.chars().any(|c| c.is_control()) {
        return Err("Invalid characters".into());
    }
    let scope = if global { "--global" } else { "--local" };
    run(&repo, &["config", scope, "user.name", &name])?;
    run(&repo, &["config", scope, "user.email", &email])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_option_like_refs() {
        assert!(rf("--upload-pack=evil").is_err());
        assert!(rf("-f").is_err());
        assert!(rf("").is_err());
        assert!(rf("a\nb").is_err());
        assert!(rf("feature/x").is_ok());
    }

    #[test]
    fn clone_urls() {
        assert!(clone_url_ok("https://github.com/a/b.git"));
        assert!(clone_url_ok("git@github.com:a/b.git"));
        assert!(clone_url_ok("ssh://git@host/a/b"));
        assert!(!clone_url_ok("ext::sh -c evil"));
        assert!(!clone_url_ok("http://insecure/a"));
        assert!(!clone_url_ok("git://insecure/a"));
        assert!(!clone_url_ok("--upload-pack=evil"));
        assert!(!clone_url_ok("-oProxyCommand=evil@host:x"));
    }

    #[test]
    fn redacts_credentials() {
        assert_eq!(redact_url("https://u:tok@github.com/a/b"), "https://***@github.com/a/b");
        assert_eq!(redact_url("https://github.com/a/b"), "https://github.com/a/b");
        assert_eq!(redact_url("git@github.com:a/b.git"), "git@github.com:a/b.git");
    }

    /// End-to-end against a real throwaway repository.
    #[test]
    fn full_workflow() {
        let root = std::env::temp_dir().join(format!("gitolotl-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let r = root.to_string_lossy().into_owned();
        let repo = repo_init(r.clone()).unwrap().path;
        set_identity(repo.clone(), "Axo Lotl".into(), "axo@example.com".into(), false).unwrap();
        run(&repo, &["config", "commit.gpgsign", "false"]).unwrap();
        let w = |name: &str, text: &str| std::fs::write(Path::new(&repo).join(name), text).unwrap();

        // empty repo is handled
        assert!(get_log(repo.clone(), 10, true, None, false).unwrap().is_empty());

        // untracked -> staged -> committed
        let base: String = (1..=30).map(|i| format!("line {i}\n")).collect();
        w("a.txt", &base);
        w("-dash file.txt", "tricky name\n");
        let s = get_status(repo.clone()).unwrap();
        assert_eq!(s.files.len(), 2);
        assert!(s.files.iter().all(|f| f.kind == "untracked"));
        assert!(get_diff(repo.clone(), "untracked".into(), "a.txt".into(), None, None).unwrap().text.contains("+line 1"));
        stage(repo.clone(), vec!["a.txt".into(), "-dash file.txt".into()]).unwrap();
        commit(repo.clone(), "first".into(), false, false).unwrap();

        // two separate hunks; stage only the first via a patch
        w("a.txt", &base.replace("line 2\n", "line two\n").replace("line 29\n", "line twenty-nine\n"));
        let d = get_diff(repo.clone(), "worktree".into(), "a.txt".into(), None, None).unwrap().text;
        let parts: Vec<&str> = d.split("\n@@").collect();
        assert_eq!(parts.len(), 3, "expected two hunks: {d}");
        let patch = format!("{}\n@@{}\n", parts[0], parts[1]);
        apply_patch(repo.clone(), patch, true, false).unwrap();
        let staged = get_diff(repo.clone(), "staged".into(), "a.txt".into(), None, None).unwrap().text;
        assert!(staged.contains("+line two") && !staged.contains("twenty-nine"));
        let s = get_status(repo.clone()).unwrap();
        assert_eq!((s.files[0].x.as_str(), s.files[0].y.as_str()), ("M", "M"));
        commit(repo.clone(), "second".into(), false, true).unwrap();
        stage_all(repo.clone()).unwrap();
        commit(repo.clone(), "third".into(), false, false).unwrap();

        let log = get_log(repo.clone(), 10, true, None, false).unwrap();
        assert_eq!(log.iter().map(|c| c.subject.as_str()).collect::<Vec<_>>(), ["third", "second", "first"]);
        assert!(log[0].refs.iter().any(|r| r.starts_with("HEAD -> refs/heads/")));
        let det = get_commit_details(repo.clone(), log[1].hash.clone()).unwrap();
        assert_eq!(det.files.len(), 1);
        assert!(det.message.contains("Signed-off-by"));
        let blame = get_blame(repo.clone(), "a.txt".into(), None).unwrap();
        assert_eq!(blame.len(), 30);
        assert_eq!(blame[1].summary, "second");
        assert_eq!(get_log(repo.clone(), 10, false, Some("a.txt".into()), false).unwrap().len(), 3);

        // branches, tags, refs
        create_branch(repo.clone(), "feature/x".into(), Some(log[2].hash.clone()), false, None).unwrap();
        create_tag(repo.clone(), "v1".into(), None, Some("release".into())).unwrap();
        let refs = get_refs(repo.clone()).unwrap();
        assert!(refs.iter().any(|x| x.short == "feature/x" && x.kind == "head" && !x.is_head));
        assert!(refs.iter().any(|x| x.short == "v1" && x.kind == "tag" && x.hash == log[0].hash));
        assert!(create_branch(repo.clone(), "--evil".into(), None, false, None).is_err());

        // interactive rebase: squash "third" into "second"
        let cands = rebase_candidates(repo.clone(), log[1].hash.clone()).unwrap();
        assert_eq!(cands.len(), 2);
        rebase_interactive(
            repo.clone(),
            log[1].hash.clone(),
            vec![
                TodoItem { action: "pick".into(), hash: cands[0].hash.clone() },
                TodoItem { action: "squash".into(), hash: cands[1].hash.clone() },
            ],
        )
        .unwrap();
        let log2 = get_log(repo.clone(), 10, false, None, false).unwrap();
        assert_eq!(log2.len(), 2, "squash should leave two commits");
        assert!(get_status(repo.clone()).unwrap().state.is_empty());

        // stash round trip
        w("a.txt", "changed\n");
        stash_push(repo.clone(), "wip".into(), true).unwrap();
        assert!(get_status(repo.clone()).unwrap().files.is_empty());
        assert_eq!(get_stashes(repo.clone()).unwrap().len(), 1);
        stash_op(repo.clone(), "pop".into(), 0, None).unwrap();
        discard(repo.clone(), vec!["a.txt".into()], vec![]).unwrap();
        assert!(get_status(repo.clone()).unwrap().files.is_empty());

        // conflict -> state detection -> abort
        checkout(repo.clone(), "feature/x".into(), "head".into()).unwrap();
        w("a.txt", "conflicting\n");
        stage_all(repo.clone()).unwrap();
        commit(repo.clone(), "diverge".into(), false, false).unwrap();
        assert!(merge(repo.clone(), log2[0].hash.clone(), "ff".into()).is_err());
        let s = get_status(repo.clone()).unwrap();
        assert_eq!(s.state, "merge");
        assert!(s.files.iter().any(|f| f.kind == "conflict"));
        resolve_conflict(repo.clone(), "a.txt".into(), "theirs".into()).unwrap();
        op_continue(repo.clone(), "merge".into()).unwrap();
        assert!(get_status(repo.clone()).unwrap().state.is_empty());

        let _ = std::fs::remove_dir_all(&root);
    }

    /// Dumps real command output for a repo as JSON, for previewing the UI in a browser:
    /// `GITOLOTL_FIXTURE_REPO=<repo> GITOLOTL_FIXTURE_OUT=<file> cargo test --lib dump_fixture -- --ignored`
    #[test]
    #[ignore]
    fn dump_fixture() {
        let repo = std::env::var("GITOLOTL_FIXTURE_REPO").expect("GITOLOTL_FIXTURE_REPO");
        let out = std::env::var("GITOLOTL_FIXTURE_OUT").expect("GITOLOTL_FIXTURE_OUT");
        fn j<T: Serialize>(v: &T) -> serde_json::Value {
            serde_json::to_value(v).unwrap()
        }
        let info = repo_open(repo.clone()).unwrap();
        let repo = info.path.clone();
        let log = get_log(repo.clone(), 500, true, None, false).unwrap();
        let status = get_status(repo.clone()).unwrap();
        let mut details = serde_json::Map::new();
        for c in &log {
            details.insert(c.hash.clone(), j(&get_commit_details(repo.clone(), c.hash.clone()).unwrap()));
        }
        let mut diffs = serde_json::Map::new();
        for f in &status.files {
            for kind in ["worktree", "staged", "untracked"] {
                if let Ok(d) = get_diff(repo.clone(), kind.into(), f.path.clone(), None, None) {
                    diffs.insert(format!("{kind}:{}", f.path), j(&d));
                }
            }
        }
        let first = log.last().unwrap().hash.clone();
        let fixture = serde_json::json!({
            "repo_open": j(&info),
            "get_status": j(&status),
            "get_log": j(&log),
            "get_refs": j(&get_refs(repo.clone()).unwrap()),
            "get_remotes": j(&get_remotes(repo.clone()).unwrap()),
            "get_stashes": j(&get_stashes(repo.clone()).unwrap()),
            "get_identity": j(&get_identity(repo.clone()).unwrap()),
            "get_blame": j(&get_blame(repo.clone(), "app.txt".into(), None).unwrap()),
            "rebase_candidates": j(&rebase_candidates(repo.clone(), first).unwrap()),
            "details": details,
            "diffs": diffs,
        });
        std::fs::write(out, serde_json::to_string(&fixture).unwrap()).unwrap();
    }

    fn temp_repo(tag: &str) -> (PathBuf, String) {
        let root = std::env::temp_dir().join(format!("gitolotl-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let repo = repo_init(root.to_string_lossy().into_owned()).unwrap().path;
        set_identity(repo.clone(), "Axo Lotl".into(), "axo@example.com".into(), false).unwrap();
        run(&repo, &["config", "commit.gpgsign", "false"]).unwrap();
        // git may start background maintenance after a commit, which creates and removes
        // lock files on its own schedule. Tests that compare the repository byte for byte
        // must only see what Gitolotl itself does.
        run(&repo, &["config", "gc.auto", "0"]).unwrap();
        run(&repo, &["config", "maintenance.auto", "false"]).unwrap();
        (root, repo)
    }

    /// Everything Gitolotl can destroy must be recoverable from a backup ref.
    #[test]
    fn destructive_operations_are_recoverable() {
        let (root, repo) = temp_repo("safety");
        let p = |n: &str| Path::new(&repo).join(n);
        let show = |rev: &str, file: &str| run(&repo, &["show", &format!("{rev}:{file}")]).unwrap().replace("\r\n", "\n");
        std::fs::write(p("a.txt"), "one\n").unwrap();
        stage_all(repo.clone()).unwrap();
        commit(repo.clone(), "first".into(), false, false).unwrap();
        let first = run(&repo, &["rev-parse", "HEAD"]).unwrap().trim().to_string();

        // 1. discard: tracked edit + untracked file both survive in the snapshot
        std::fs::write(p("a.txt"), "precious edit\n").unwrap();
        std::fs::write(p("new.txt"), "precious new file\n").unwrap();
        // taking a snapshot on its own changes nothing the user can see
        let index_before = std::fs::read(p(".git/index")).unwrap();
        let status_before = run(&repo, &["status", "--porcelain"]).unwrap();
        let probe = snapshot_worktree(&repo, "probe").unwrap().expect("dirty tree");
        assert_eq!(std::fs::read(p(".git/index")).unwrap(), index_before);
        assert_eq!(run(&repo, &["status", "--porcelain"]).unwrap(), status_before);
        assert_eq!(std::fs::read_to_string(p("a.txt")).unwrap(), "precious edit\n");
        assert_eq!(show(&probe, "new.txt"), "precious new file\n");
        delete_backup(repo.clone(), get_backups(repo.clone()).unwrap()[0].name.clone()).unwrap();

        discard(repo.clone(), vec!["a.txt".into()], vec!["new.txt".into()]).unwrap();
        assert!(!p("new.txt").exists());
        assert_eq!(std::fs::read_to_string(p("a.txt")).unwrap().replace("\r\n", "\n"), "one\n");
        let b = get_backups(repo.clone()).unwrap();
        assert_eq!(b.len(), 1);
        assert_eq!(b[0].label, "discard");
        assert_eq!(show(&b[0].hash, "a.txt"), "precious edit\n");
        assert_eq!(show(&b[0].hash, "new.txt"), "precious new file\n");
        // the snapshot is a child of HEAD and never touched the real index or HEAD
        assert_eq!(run(&repo, &["rev-parse", &format!("{}^", b[0].hash)]).unwrap().trim(), first);
        assert_eq!(run(&repo, &["rev-parse", "HEAD"]).unwrap().trim(), first);
        assert!(get_stashes(repo.clone()).unwrap().is_empty());

        // 2. hard reset: both the old HEAD and the dirty tree are kept
        std::fs::write(p("a.txt"), "two\n").unwrap();
        stage_all(repo.clone()).unwrap();
        commit(repo.clone(), "second".into(), false, false).unwrap();
        let second = run(&repo, &["rev-parse", "HEAD"]).unwrap().trim().to_string();
        std::fs::write(p("a.txt"), "uncommitted three\n").unwrap();
        reset(repo.clone(), first.clone(), "hard".into()).unwrap();
        let b = get_backups(repo.clone()).unwrap();
        assert!(b.iter().any(|x| x.label == "reset" && x.hash == second));
        let snap = b.iter().find(|x| x.label == "reset-hard").expect("worktree snapshot");
        assert_eq!(show(&snap.hash, "a.txt"), "uncommitted three\n");

        // 3. force-deleted branch, deleted tag, dropped stash, amended commit
        create_branch(repo.clone(), "doomed".into(), Some(second.clone()), false, None).unwrap();
        delete_branch(repo.clone(), "doomed".into(), true).unwrap();
        create_tag(repo.clone(), "v9".into(), Some(second.clone()), None).unwrap();
        delete_tag(repo.clone(), "v9".into()).unwrap();
        std::fs::write(p("a.txt"), "stashed work\n").unwrap();
        stash_push(repo.clone(), "wip".into(), true).unwrap();
        let stash_hash = get_stashes(repo.clone()).unwrap()[0].hash.clone();
        stash_op(repo.clone(), "drop".into(), 0, None).unwrap();
        commit(repo.clone(), "first, amended".into(), true, false).unwrap();
        let b = get_backups(repo.clone()).unwrap();
        assert!(b.iter().any(|x| x.label == "delete-branch" && x.hash == second));
        assert!(b.iter().any(|x| x.label == "delete-tag" && x.hash == second));
        assert!(b.iter().any(|x| x.label == "drop-stash" && x.hash == stash_hash));
        assert!(b.iter().any(|x| x.label == "amend" && x.hash == first));
        assert_eq!(show(&stash_hash, "a.txt"), "stashed work\n");

        // 4. backups survive garbage collection and are never part of a push
        run(&repo, &["reflog", "expire", "--expire=now", "--all"]).unwrap();
        run(&repo, &["gc", "--prune=now", "--quiet"]).unwrap();
        for x in &b {
            assert!(run(&repo, &["cat-file", "-e", &format!("{}^{{commit}}", x.hash)]).is_ok(), "{} lost", x.label);
        }
        assert!(delete_backup(repo.clone(), "refs/heads/main".into()).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Undo must put things back exactly, and never move the wrong branch.
    #[test]
    fn undo_restores_what_was_lost() {
        let (root, repo) = temp_repo("undo");
        let p = |n: &str| Path::new(&repo).join(n);
        let read = |n: &str| std::fs::read_to_string(p(n)).unwrap().replace("\r\n", "\n");
        let head = || run(&repo, &["rev-parse", "HEAD"]).unwrap().trim().to_string();
        let newest = |label: &str| get_backups(repo.clone()).unwrap().into_iter().find(|b| b.label == label).expect(label);
        std::fs::write(p("a.txt"), "one\n").unwrap();
        stage_all(repo.clone()).unwrap();
        commit(repo.clone(), "first".into(), false, false).unwrap();
        let first = head();
        let branch = cur_branch(&repo);

        // discard, then undo: the edit and the untracked file come back
        std::fs::write(p("a.txt"), "edited\n").unwrap();
        std::fs::write(p("new.txt"), "brand new\n").unwrap();
        discard(repo.clone(), vec!["a.txt".into()], vec!["new.txt".into()]).unwrap();
        restore_backup(repo.clone(), newest("discard").name).unwrap();
        assert_eq!(read("a.txt"), "edited\n");
        assert_eq!(read("new.txt"), "brand new\n");

        // hard reset with uncommitted work, then undo: commit and work both come back
        stage_all(repo.clone()).unwrap();
        commit(repo.clone(), "second".into(), false, false).unwrap();
        let second = head();
        std::fs::write(p("a.txt"), "uncommitted\n").unwrap();
        reset(repo.clone(), first.clone(), "hard".into()).unwrap();
        assert_eq!(head(), first);
        restore_backup(repo.clone(), newest("reset-hard").name).unwrap();
        assert_eq!(head(), second);
        assert_eq!(read("a.txt"), "uncommitted\n");
        discard(repo.clone(), vec!["a.txt".into()], vec![]).unwrap();

        // mixed reset, then undo: back to a clean tree on the old commit
        reset(repo.clone(), first.clone(), "mixed".into()).unwrap();
        let b = newest("reset");
        assert_eq!(b.detail, branch);
        restore_backup(repo.clone(), b.name).unwrap();
        assert_eq!(head(), second);
        assert!(get_status(repo.clone()).unwrap().files.is_empty());

        // amend, then undo
        commit(repo.clone(), "second, reworded".into(), true, false).unwrap();
        assert_ne!(head(), second);
        restore_backup(repo.clone(), newest("amend").name).unwrap();
        assert_eq!(head(), second);

        // deleted branch and tag and dropped stash come back under their own names
        create_branch(repo.clone(), "feature/doomed".into(), Some(first.clone()), false, None).unwrap();
        delete_branch(repo.clone(), "feature/doomed".into(), true).unwrap();
        let b = newest("delete-branch");
        assert_eq!(b.detail, "feature/doomed");
        restore_backup(repo.clone(), b.name).unwrap();
        assert_eq!(run(&repo, &["rev-parse", "refs/heads/feature/doomed"]).unwrap().trim(), first);
        create_tag(repo.clone(), "v9".into(), Some(first.clone()), None).unwrap();
        delete_tag(repo.clone(), "v9".into()).unwrap();
        restore_backup(repo.clone(), newest("delete-tag").name).unwrap();
        assert_eq!(run(&repo, &["rev-parse", "refs/tags/v9"]).unwrap().trim(), first);
        std::fs::write(p("a.txt"), "stashed\n").unwrap();
        stash_push(repo.clone(), "wip".into(), true).unwrap();
        stash_op(repo.clone(), "drop".into(), 0, None).unwrap();
        restore_backup(repo.clone(), newest("drop-stash").name).unwrap();
        assert_eq!(get_stashes(repo.clone()).unwrap().len(), 1);

        // an undo recorded on one branch refuses to move another
        reset(repo.clone(), first.clone(), "mixed".into()).unwrap();
        let b = newest("reset");
        discard(repo.clone(), vec!["a.txt".into()], vec![]).unwrap();
        checkout(repo.clone(), "feature/doomed".into(), "head".into()).unwrap();
        assert!(restore_backup(repo.clone(), b.name).unwrap_err().contains("Check that branch out first"));
        assert_eq!(head(), first);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn merge_editor_worktrees_and_unpushed() {
        let (root, repo) = temp_repo("merge");
        let p = |n: &str| Path::new(&repo).join(n);
        std::fs::write(p("a.txt"), "base\n").unwrap();
        stage_all(repo.clone()).unwrap();
        commit(repo.clone(), "base".into(), false, false).unwrap();
        let main = cur_branch(&repo);
        create_branch(repo.clone(), "other".into(), None, true, None).unwrap();
        std::fs::write(p("a.txt"), "theirs\n").unwrap();
        stage_all(repo.clone()).unwrap();
        commit(repo.clone(), "theirs".into(), false, false).unwrap();
        checkout(repo.clone(), main.clone(), "head".into()).unwrap();
        std::fs::write(p("a.txt"), "ours\n").unwrap();
        stage_all(repo.clone()).unwrap();
        commit(repo.clone(), "ours".into(), false, false).unwrap();

        // nothing on a remote yet, so both commits would be published
        assert_eq!(get_unpushed(repo.clone()).unwrap().len(), 2);

        // conflict -> read with markers -> write a hand-merged result
        assert!(get_conflict(repo.clone(), "a.txt".into()).is_err(), "not in conflict yet");
        assert!(merge(repo.clone(), "other".into(), "ff".into()).is_err());
        let text = get_conflict(repo.clone(), "a.txt".into()).unwrap();
        assert!(text.contains("<<<<<<<") && text.contains("ours") && text.contains("theirs"));
        assert!(resolve_with_content(repo.clone(), "../escape.txt".into(), "x".into()).is_err());
        assert!(resolve_with_content(repo.clone(), "b.txt".into(), "x".into()).is_err(), "only conflicted files");
        resolve_with_content(repo.clone(), "a.txt".into(), "ours and theirs\n".into()).unwrap();
        let s = get_status(repo.clone()).unwrap();
        assert!(s.files.iter().all(|f| f.kind != "conflict"));
        op_continue(repo.clone(), "merge".into()).unwrap();
        assert_eq!(std::fs::read_to_string(p("a.txt")).unwrap(), "ours and theirs\n");
        // the pre-edit file (with markers) is kept
        assert!(get_backups(repo.clone()).unwrap().iter().any(|b| b.label == "merge-edit"));

        // worktrees: add, inspect, refuse to remove while dirty, remove when clean
        let wt = root.parent().unwrap().join(format!("gitolotl-wt-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&wt);
        let wt_s = wt.to_string_lossy().replace('\\', "/");
        add_worktree(repo.clone(), wt_s.clone(), "agent/task".into(), true).unwrap();
        std::fs::write(wt.join("scratch.txt"), "agent work\n").unwrap();
        let d = get_worktree_details(repo.clone()).unwrap();
        assert_eq!(d.len(), 2);
        let w = d.iter().find(|w| !w.current).unwrap();
        assert_eq!(w.branch.as_deref(), Some("agent/task"));
        assert_eq!(w.dirty, 1);
        assert_eq!(w.last.as_ref().unwrap().parents.len(), 2);
        let listed = w.path.clone();
        assert!(remove_worktree(repo.clone(), listed.clone()).is_err(), "dirty worktree must not be removed");
        assert!(wt.join("scratch.txt").exists());
        assert!(remove_worktree(repo.clone(), repo.clone()).is_err(), "never the current worktree");
        std::fs::remove_file(wt.join("scratch.txt")).unwrap();
        remove_worktree(repo.clone(), listed).unwrap();
        assert_eq!(get_worktrees(repo.clone()).unwrap().len(), 1);

        // the CLI entry point snapshots a dirty tree and reports a clean one
        assert_eq!(snapshot_now(&repo).unwrap(), None);
        std::fs::write(p("a.txt"), "agent about to start\n").unwrap();
        let snap = snapshot_now(&repo).unwrap().expect("snapshot");
        assert_eq!(run(&repo, &["show", &format!("{snap}:a.txt")]).unwrap().replace("\r\n", "\n"), "agent about to start\n");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&wt);
    }

    /// Creating a branch must never lose uncommitted work, whichever option is chosen and
    /// whether or not the switch succeeds.
    #[test]
    fn branching_keeps_uncommitted_work() {
        let (root, repo) = temp_repo("branching");
        // compare file contents byte for byte, whatever the machine's line-ending setting
        run(&repo, &["config", "core.autocrlf", "false"]).unwrap();
        let p = |n: &str| Path::new(&repo).join(n);
        let read = |n: &str| std::fs::read_to_string(p(n)).unwrap();
        std::fs::write(p("a.txt"), "base\n").unwrap();
        std::fs::write(p("b.txt"), "base\n").unwrap();
        stage_all(repo.clone()).unwrap();
        commit(repo.clone(), "base".into(), false, false).unwrap();
        let main = cur_branch(&repo);
        create_branch(repo.clone(), "side".into(), None, true, None).unwrap();
        std::fs::write(p("a.txt"), "side\n").unwrap();
        stage_all(repo.clone()).unwrap();
        commit(repo.clone(), "side".into(), false, false).unwrap();
        checkout(repo.clone(), main.clone(), "head".into()).unwrap();
        assert_eq!(default_branch(repo.clone()).unwrap(), None, "no remote, no default");
        assert!(create_branch(repo.clone(), "x".into(), None, true, Some("nonsense".into())).is_err());

        // uncommitted work: a staged edit and a new file
        std::fs::write(p("b.txt"), "my edit\n").unwrap();
        stage(repo.clone(), vec!["b.txt".into()]).unwrap();
        std::fs::write(p("new.txt"), "brand new\n").unwrap();

        // bring: the work comes along
        create_branch(repo.clone(), "f1".into(), None, true, Some("bring".into())).unwrap();
        assert_eq!(cur_branch(&repo), "f1");
        assert_eq!(read("b.txt"), "my edit\n");
        assert_eq!(read("new.txt"), "brand new\n");
        assert_eq!(get_status(repo.clone()).unwrap().files.len(), 2);

        // leave: the new branch starts clean, the work waits in a labelled stash
        let msg = create_branch(repo.clone(), "f2".into(), Some("side".into()), true, Some("leave".into())).unwrap();
        assert!(msg.contains("stayed behind"), "{msg}");
        assert_eq!(cur_branch(&repo), "f2");
        assert_eq!(read("a.txt"), "side\n");
        assert!(get_status(repo.clone()).unwrap().files.is_empty());
        assert!(!p("new.txt").exists());
        let stashes = get_stashes(repo.clone()).unwrap();
        assert_eq!(stashes.len(), 1);
        assert!(stashes[0].message.contains("Left on f1 when creating f2"), "{}", stashes[0].message);
        // ...and comes back whole, staged state included
        checkout(repo.clone(), "f1".into(), "head".into()).unwrap();
        stash_op(repo.clone(), "pop".into(), 0, None).unwrap();
        assert_eq!(read("b.txt"), "my edit\n");
        assert_eq!(read("new.txt"), "brand new\n");
        assert!(get_stashes(repo.clone()).unwrap().is_empty());

        // bring, but the work collides with the starting point: refused, nothing changes
        std::fs::write(p("a.txt"), "precious\n").unwrap();
        let e = create_branch(repo.clone(), "f3".into(), Some("side".into()), true, Some("bring".into())).unwrap_err();
        assert!(e.contains("Nothing was changed"), "{e}");
        assert_eq!(cur_branch(&repo), "f1");
        assert_eq!(read("a.txt"), "precious\n");
        assert!(run(&repo, &["show-ref", "--verify", "-q", "refs/heads/f3"]).is_err());

        // leave, but the switch fails (name taken): the work is put straight back
        assert!(create_branch(repo.clone(), "side".into(), Some(main.clone()), true, Some("leave".into())).is_err());
        assert_eq!(cur_branch(&repo), "f1");
        assert_eq!(read("a.txt"), "precious\n");
        assert_eq!(read("b.txt"), "my edit\n");
        assert_eq!(read("new.txt"), "brand new\n");
        assert_eq!(get_status(repo.clone()).unwrap().files.len(), 3);
        assert!(get_stashes(repo.clone()).unwrap().is_empty(), "no stray stash left behind");

        // an existing stash is never touched when there is nothing of ours to pop
        stash_push(repo.clone(), "someone else's".into(), true).unwrap();
        assert!(create_branch(repo.clone(), "side".into(), None, true, Some("leave".into())).is_err());
        let stashes = get_stashes(repo.clone()).unwrap();
        assert_eq!(stashes.len(), 1);
        assert!(stashes[0].message.contains("someone else's"));

        let _ = std::fs::remove_dir_all(root);
    }

    /// Pull on a branch with no upstream works out what is meant instead of failing with
    /// git's "no tracking information", and never rewrites an upstream that is already set.
    #[test]
    fn pull_without_upstream() {
        let (root, repo) = temp_repo("pullup");
        let bare = std::env::temp_dir().join(format!("gitolotl-pullup-bare-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&bare);
        std::fs::create_dir_all(&bare).unwrap();
        let bare_s = bare.to_string_lossy().into_owned();
        run(&bare_s, &["init", "--bare"]).unwrap();
        let tracks = |b: &str| run(&repo, &["config", "--get", &format!("branch.{b}.merge")]).map(|s| s.trim().to_string()).ok();
        let tip = |r: &str| run(&repo, &["rev-parse", r]).unwrap().trim().to_string();
        let write = |text: &str, msg: &str| {
            std::fs::write(Path::new(&repo).join("a.txt"), text).unwrap();
            stage_all(repo.clone()).unwrap();
            commit(repo.clone(), msg.into(), false, false).unwrap();
        };
        write("base\n", "base");
        let main = cur_branch(&repo);

        // no remote at all
        create_branch(repo.clone(), "topic".into(), None, true, None).unwrap();
        assert!(pull(repo.clone(), "merge".into()).unwrap_err().contains("no remote"));
        run(&repo, &["remote", "add", "origin", &bare_s]).unwrap();
        run(&repo, &["push", "origin", &main]).unwrap();

        // never pushed: nothing to pull, and that is not an error
        let msg = pull(repo.clone(), "merge".into()).unwrap();
        assert!(msg.contains("has not been pushed yet"), "{msg}");
        assert_eq!(tracks("topic"), None);

        // the same name on the remote, one commit ahead of us
        run(&repo, &["push", "origin", "topic"]).unwrap();
        create_branch(repo.clone(), "ahead".into(), None, true, None).unwrap();
        write("newer\n", "newer");
        run(&repo, &["push", "origin", "ahead:topic"]).unwrap();
        checkout(repo.clone(), "topic".into(), "head".into()).unwrap();
        let msg = pull(repo.clone(), "ff-only".into()).unwrap();
        assert!(msg.contains("topic now tracks origin/topic"), "{msg}");
        assert_eq!(tip("HEAD"), tip("ahead"));
        assert_eq!(tracks("topic").as_deref(), Some("refs/heads/topic"));
        pull(repo.clone(), "merge".into()).unwrap();

        // a branch cut from a remote branch tracks it only when it is that branch
        create_branch(repo.clone(), "feature".into(), Some("origin/topic".into()), false, None).unwrap();
        assert_eq!(tracks("feature"), None);
        run(&repo, &["push", "origin", "topic:same"]).unwrap();
        create_branch(repo.clone(), "same".into(), Some("origin/same".into()), true, None).unwrap();
        assert_eq!(tracks("same").as_deref(), Some("refs/heads/same"));

        // its upstream is deleted: say so, and leave the setting alone
        run(&repo, &["push", "origin", "--delete", "same"]).unwrap();
        let e = pull(repo.clone(), "merge".into()).unwrap_err();
        assert!(e.contains("no longer exists"), "{e}");
        assert_eq!(tracks("same").as_deref(), Some("refs/heads/same"));

        // detached HEAD
        checkout(repo.clone(), tip("HEAD"), "commit".into()).unwrap();
        assert!(pull(repo.clone(), "merge".into()).unwrap_err().contains("not on a branch"));

        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(bare);
        // the folder itself is gone (a removed worktree): say that, not "not on a branch"
        assert!(pull(repo.clone(), "merge".into()).unwrap_err().contains("Not a directory"));
    }

    /// Settings and hooks that make git run programs are found, by a scan that runs nothing.
    #[test]
    fn finds_settings_that_run_programs() {
        let (root, repo) = temp_repo("trust");
        let clean = repo_risks(repo.clone()).unwrap();
        assert!(clean.items.is_empty(), "{:?}", clean.items);

        // If git ran this, the marker file would appear.
        let marker = root.join("ran.marker");
        let cmd = format!("echo ran > '{}'", marker.to_string_lossy().replace('\\', "/"));
        run(&repo, &["config", "core.fsmonitor", &cmd]).unwrap();
        run(&repo, &["config", "filter.sneaky.clean", "sneaky-filter"]).unwrap();
        run(&repo, &["config", "credential.helper", "!evil"]).unwrap();
        run(&repo, &["config", "http.sslVerify", "false"]).unwrap();
        run(&repo, &["config", "core.autocrlf", "false"]).unwrap();
        let hooks = Path::new(&repo).join(".git").join("hooks");
        std::fs::create_dir_all(&hooks).unwrap();
        std::fs::write(hooks.join("pre-commit"), "#!/bin/sh\n").unwrap();
        std::fs::write(hooks.join("pre-push.sample"), "#!/bin/sh\n").unwrap();

        repo_open(repo.clone()).unwrap();
        let found = repo_risks(repo.clone()).unwrap();
        let what: Vec<&str> = found.items.iter().map(|r| r.what.as_str()).collect();
        assert_eq!(what, ["core.fsmonitor", "filter.sneaky.clean", "credential.helper", "http.sslverify", "hook"], "{:?}", found.items);
        assert_eq!(found.items[4].value, "pre-commit", "sample hooks are ignored");
        assert_ne!(found.fingerprint, clean.fingerprint);
        assert!(!marker.exists(), "opening and scanning must not run the repository's programs");

        // the built-in watcher (a plain on/off) and verified TLS are not worth a question
        run(&repo, &["config", "core.fsmonitor", "true"]).unwrap();
        run(&repo, &["config", "http.sslVerify", "true"]).unwrap();
        let later = repo_risks(repo.clone()).unwrap();
        assert!(!later.items.iter().any(|r| r.what == "core.fsmonitor" || r.what == "http.sslverify"));
        assert_ne!(later.fingerprint, found.fingerprint, "a changed list is asked about again");
        // leave no watcher daemon behind
        run(&repo, &["config", "core.fsmonitor", "false"]).unwrap();
        let _ = std::fs::remove_dir_all(root);
    }

    /// Files the app reads or writes itself stay inside the repository, and its temporary
    /// files never reuse something already at that name.
    #[test]
    fn app_file_access_stays_inside_the_repository() {
        let (root, repo) = temp_repo("inside");
        std::fs::write(Path::new(&repo).join("a.txt"), "x\n").unwrap();
        assert!(inside(&repo, "a.txt").is_ok());
        assert!(inside_file(&repo, "a.txt").is_ok());
        assert!(inside(&repo, "../outside.txt").is_err());
        assert!(inside(&repo, "sub/../a.txt").is_err());
        assert!(inside(&repo, &std::env::temp_dir().join("x.txt").to_string_lossy()).is_err());
        // the untracked-file diff reads the file directly, so it is held to the same rule
        assert!(get_diff(repo.clone(), "untracked".into(), "../outside.txt".into(), None, None).is_err());
        assert!(get_diff(repo.clone(), "untracked".into(), "a.txt".into(), None, None).is_ok());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(std::env::temp_dir(), Path::new(&repo).join("out")).unwrap();
            assert!(inside(&repo, "out/x.txt").is_err(), "a symlinked folder must not lead out");
            std::os::unix::fs::symlink("a.txt", Path::new(&repo).join("link")).unwrap();
            assert!(inside_file(&repo, "link").is_err(), "a symlink is not edited as text");
        }
        let t = root.join("exclusive.tmp");
        new_file(&t).unwrap();
        assert!(new_file(&t).is_err(), "an existing file is never reused");
        let _ = std::fs::remove_dir_all(root);
    }

    /// Looking at a repository must never modify it.
    #[test]
    fn reading_never_writes() {
        let (root, repo) = temp_repo("readonly");
        std::fs::write(Path::new(&repo).join("a.txt"), "one\n").unwrap();
        stage_all(repo.clone()).unwrap();
        commit(repo.clone(), "first".into(), false, false).unwrap();
        std::fs::write(Path::new(&repo).join("a.txt"), "changed\n").unwrap();
        std::fs::write(Path::new(&repo).join("b.txt"), "untracked\n").unwrap();

        fn fingerprint(dir: &Path, out: &mut Vec<(String, Vec<u8>)>) {
            let mut entries: Vec<_> = std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().path()).collect();
            entries.sort();
            for e in entries {
                if e.is_dir() {
                    fingerprint(&e, out);
                } else {
                    out.push((e.to_string_lossy().into_owned(), std::fs::read(&e).unwrap()));
                }
            }
        }
        let mut before = vec![];
        fingerprint(Path::new(&repo), &mut before);

        let head = get_status(repo.clone()).unwrap().head;
        get_log(repo.clone(), 100, true, None, false).unwrap();
        get_refs(repo.clone()).unwrap();
        get_remotes(repo.clone()).unwrap();
        get_stashes(repo.clone()).unwrap();
        get_worktrees(repo.clone()).unwrap();
        get_backups(repo.clone()).unwrap();
        get_commit_details(repo.clone(), head.clone()).unwrap();
        get_diff(repo.clone(), "worktree".into(), "a.txt".into(), None, None).unwrap();
        get_diff(repo.clone(), "untracked".into(), "b.txt".into(), None, None).unwrap();
        get_patch(repo.clone(), "worktree".into(), None).unwrap();
        get_patch(repo.clone(), "commit".into(), Some(head.clone())).unwrap();
        get_blame(repo.clone(), "a.txt".into(), None).unwrap();
        get_identity(repo.clone()).unwrap();
        rebase_candidates(repo.clone(), head).unwrap();

        let mut after = vec![];
        fingerprint(Path::new(&repo), &mut after);
        let names = |v: &[(String, Vec<u8>)]| v.iter().map(|x| x.0.clone()).collect::<Vec<_>>();
        assert_eq!(names(&before), names(&after), "a read command created or removed files");
        for (b, a) in before.iter().zip(&after) {
            assert_eq!(b.0, a.0);
            assert!(b.1 == a.1, "a read command modified {}", b.0);
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn parses_log_records() {
        let s = "aa\x1fbb cc\x1fAnn\x1fa@x\x1f10\x1fsubj\x1fHEAD -> refs/heads/main, tag: refs/tags/v1\x1fClaude <a@b>,Bob <b@c>\x1e\n";
        let c = parse_log(s);
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].parents, vec!["bb", "cc"]);
        assert_eq!(c[0].refs.len(), 2);
        assert_eq!(c[0].coauthors.len(), 2);
    }

    /// The "mine" view, and what clean-up relies on: knowing what is merged, never dropping
    /// the wrong stash, and clearing a worktree whose folder is gone.
    #[test]
    fn mine_and_cleanup() {
        let (root, repo) = temp_repo("cleanup");
        let p = |n: &str| Path::new(&repo).join(n);
        let save = |file: &str, other: bool| {
            std::fs::write(p(file), file).unwrap();
            stage_all(repo.clone()).unwrap();
            let mut a = vec!["commit", "-m", file];
            if other {
                a.splice(0..0, ["-c", "user.name=Someone Else", "-c", "user.email=else@example.com"]);
            }
            run(&repo, &a).unwrap();
            run(&repo, &["rev-parse", "HEAD"]).unwrap().trim().to_string()
        };
        save("a.txt", false);
        let main = cur_branch(&repo);
        create_branch(repo.clone(), "done".into(), None, false, None).unwrap();
        create_branch(repo.clone(), "theirs".into(), None, true, None).unwrap();
        let theirs = save("theirs.txt", true);
        checkout(repo.clone(), main.clone(), "head".into()).unwrap();
        create_branch(repo.clone(), "my-work".into(), None, true, None).unwrap();
        let my = save("mine.txt", false);
        checkout(repo.clone(), main.clone(), "head".into()).unwrap();

        // mine: decided by who wrote the newest commit
        let refs = get_refs(repo.clone()).unwrap();
        let r = |n: &str| refs.iter().find(|r| r.short == n).unwrap();
        assert!(r("my-work").mine && r(&main).mine && !r("theirs").mine);
        assert!(r("my-work").time > 1_600_000_000);
        let has = |log: &[Commit], h: &str| log.iter().any(|c| c.hash == h);
        let all = get_log(repo.clone(), 100, true, None, false).unwrap();
        assert!(has(&all, &my) && has(&all, &theirs));
        let mine = get_log(repo.clone(), 100, true, None, true).unwrap();
        assert!(has(&mine, &my) && !has(&mine, &theirs), "someone else's branch is not in my view");
        // what is checked out is always shown, whoever wrote it
        checkout(repo.clone(), "theirs".into(), "head".into()).unwrap();
        assert!(has(&get_log(repo.clone(), 100, true, None, true).unwrap(), &theirs));
        checkout(repo.clone(), main.clone(), "head".into()).unwrap();

        // merged: only branches with nothing of their own
        let merged = merged_branches(repo.clone(), main.clone()).unwrap();
        assert!(merged.contains(&"done".to_string()) && merged.contains(&main));
        assert!(!merged.contains(&"theirs".to_string()) && !merged.contains(&"my-work".to_string()));
        assert!(merged_branches(repo.clone(), "--all".into()).is_err());

        // a stash is dropped only if it is still the one that was meant
        std::fs::write(p("a.txt"), "one").unwrap();
        stash_push(repo.clone(), "one".into(), true).unwrap();
        std::fs::write(p("a.txt"), "two").unwrap();
        stash_push(repo.clone(), "two".into(), true).unwrap();
        let st = get_stashes(repo.clone()).unwrap();
        assert_eq!((st[0].message.ends_with("two"), st[1].message.ends_with("one")), (true, true));
        assert!(stash_op(repo.clone(), "drop".into(), 1, Some(st[0].hash.clone())).is_err());
        assert_eq!(get_stashes(repo.clone()).unwrap().len(), 2, "a stale number must drop nothing");
        stash_op(repo.clone(), "drop".into(), 1, Some(st[1].hash.clone())).unwrap();
        let left = get_stashes(repo.clone()).unwrap();
        assert_eq!((left.len(), left[0].hash.as_str()), (1, st[0].hash.as_str()));
        assert!(get_backups(repo.clone()).unwrap().iter().any(|b| b.hash == st[1].hash), "the dropped stash is kept as a snapshot");

        // a worktree whose folder was deleted can be cleared, and its branch survives
        let wt = root.parent().unwrap().join(format!("gitolotl-cleanup-wt-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&wt);
        add_worktree(repo.clone(), wt.to_string_lossy().into_owned(), "side".into(), true).unwrap();
        std::fs::remove_dir_all(&wt).unwrap();
        let gone: Vec<WorktreeDetail> = get_worktree_details(repo.clone()).unwrap().into_iter().filter(|w| w.missing).collect();
        assert_eq!(gone.len(), 1);
        remove_worktree(repo.clone(), gone[0].path.clone()).unwrap();
        assert_eq!(get_worktrees(repo.clone()).unwrap().len(), 1);
        assert!(get_refs(repo.clone()).unwrap().iter().any(|r| r.short == "side"));

        let _ = std::fs::remove_dir_all(&root);
    }
}
