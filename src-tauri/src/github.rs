//! Minimal GitHub integration (pull requests).
//!
//! The access token is obtained from the user's own git credential helper
//! (e.g. Git Credential Manager), lives only in this process' memory, is sent
//! only to https://api.github.com, and is never exposed to the webview or
//! written to disk by Gitolotl.

use crate::git::{self, R};
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::Mutex;
use std::time::Duration;

static TOKEN: Mutex<Option<String>> = Mutex::new(None);

fn valid_part(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 100
        && s != "."
        && s != ".."
        && s.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
}

pub fn parse_slug(url: &str) -> Option<(String, String)> {
    let u = url.trim().trim_end_matches('/');
    let u = u.strip_suffix(".git").unwrap_or(u);
    let idx = u.find("github.com")?;
    if idx > 0 && !matches!(u.as_bytes()[idx - 1], b'/' | b'@') {
        return None;
    }
    let rest = &u[idx + "github.com".len()..];
    let rest = rest.strip_prefix(':').or_else(|| rest.strip_prefix('/'))?;
    let (owner, name) = rest.split_once('/')?;
    (valid_part(owner) && valid_part(name)).then(|| (owner.to_string(), name.to_string()))
}

fn slug(repo: &str) -> R<(String, String)> {
    let remotes = git::run(repo, &["remote"])?;
    let mut names: Vec<&str> = remotes.lines().filter(|l| !l.is_empty()).collect();
    names.sort_by_key(|n| *n != "origin");
    for n in names {
        if let Ok(url) = git::run(repo, &["remote", "get-url", "--", n]) {
            if let Some(s) = parse_slug(&url) {
                return Ok(s);
            }
        }
    }
    Err("This repository has no GitHub remote".into())
}

fn token(repo: &str, interactive: bool) -> Option<String> {
    if let Some(t) = TOKEN.lock().ok()?.clone() {
        return Some(t);
    }
    let d = git::dir(repo).ok()?;
    let envs: &[(&str, &str)] = if interactive { &[] } else { &[("GCM_INTERACTIVE", "never")] };
    let o = git::exec(
        &d,
        &["credential", "fill"],
        Some(b"protocol=https\nhost=github.com\n\n"),
        envs,
    )
    .ok()?;
    if o.code != 0 {
        return None;
    }
    let t = o.stdout.lines().find_map(|l| l.strip_prefix("password="))?.trim().to_string();
    if t.is_empty() {
        return None;
    }
    *TOKEN.lock().ok()? = Some(t.clone());
    Some(t)
}

fn api(method: &str, path: &str, token: Option<&str>, body: Option<Value>) -> R<Value> {
    let url = format!("https://api.github.com{path}");
    let mut req = ureq::request(method, &url)
        .timeout(Duration::from_secs(20))
        .set("Accept", "application/vnd.github+json")
        .set("X-GitHub-Api-Version", "2022-11-28")
        .set("User-Agent", "Gitolotl");
    if let Some(t) = token {
        req = req.set("Authorization", &format!("Bearer {t}"));
    }
    let res = match body {
        Some(b) => req.send_json(b),
        None => req.call(),
    };
    match res {
        Ok(r) => r.into_json::<Value>().map_err(|e| e.to_string()),
        Err(ureq::Error::Status(code, r)) => {
            if code == 401 {
                if let Ok(mut t) = TOKEN.lock() {
                    *t = None;
                }
            }
            let v: Value = r.into_json().unwrap_or(Value::Null);
            let mut msg = v["message"].as_str().unwrap_or("request failed").to_string();
            if let Some(first) = v["errors"][0]["message"].as_str() {
                msg = format!("{msg}: {first}");
            }
            Err(format!("GitHub ({code}): {msg}"))
        }
        Err(e) => Err(format!("Could not reach GitHub: {e}")),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubInfo {
    owner: String,
    name: String,
    login: Option<String>,
    default_branch: Option<String>,
}

#[tauri::command(async)]
pub fn github_info(repo: String, interactive: bool) -> R<GithubInfo> {
    let (owner, name) = slug(&repo)?;
    let tok = token(&repo, interactive);
    let login = tok
        .as_deref()
        .and_then(|t| api("GET", "/user", Some(t), None).ok())
        .and_then(|v| v["login"].as_str().map(String::from));
    let default_branch = api("GET", &format!("/repos/{owner}/{name}"), tok.as_deref(), None)
        .ok()
        .and_then(|v| v["default_branch"].as_str().map(String::from));
    Ok(GithubInfo { owner, name, login, default_branch })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    number: u64,
    title: String,
    author: String,
    head: String,
    base: String,
    url: String,
    draft: bool,
    updated: String,
}

fn pr(v: &Value) -> PullRequest {
    let s = |x: &Value| x.as_str().unwrap_or("").to_string();
    let number = v["number"].as_u64().unwrap_or(0);
    PullRequest {
        number,
        title: s(&v["title"]),
        author: s(&v["user"]["login"]),
        head: s(&v["head"]["ref"]),
        base: s(&v["base"]["ref"]),
        // Only ever hand the UI a github.com URL we built ourselves.
        url: s(&v["html_url"]),
        draft: v["draft"].as_bool().unwrap_or(false),
        updated: s(&v["updated_at"]),
    }
}

#[tauri::command(async)]
pub fn github_prs(repo: String) -> R<Vec<PullRequest>> {
    let (owner, name) = slug(&repo)?;
    let tok = token(&repo, false);
    let v = api(
        "GET",
        &format!("/repos/{owner}/{name}/pulls?state=open&per_page=50"),
        tok.as_deref(),
        None,
    )?;
    Ok(v.as_array()
        .map(|a| a.iter().map(pr).collect::<Vec<_>>())
        .unwrap_or_default()
        .into_iter()
        .filter(|p| p.url.starts_with("https://github.com/"))
        .collect())
}

#[tauri::command(async)]
pub fn github_create_pr(
    repo: String,
    title: String,
    body: String,
    head: String,
    base: String,
    draft: bool,
) -> R<PullRequest> {
    let (owner, name) = slug(&repo)?;
    let tok = token(&repo, true).ok_or(
        "No GitHub credentials found. Sign in through your git credential helper (push once, or run `git credential-manager github login`).",
    )?;
    let v = api(
        "POST",
        &format!("/repos/{owner}/{name}/pulls"),
        Some(&tok),
        Some(json!({ "title": title, "body": body, "head": head, "base": base, "draft": draft })),
    )?;
    Ok(pr(&v))
}

#[cfg(test)]
mod tests {
    use super::parse_slug;

    #[test]
    fn slugs() {
        let ok = Some(("o".to_string(), "r".to_string()));
        assert_eq!(parse_slug("https://github.com/o/r.git"), ok);
        assert_eq!(parse_slug("git@github.com:o/r.git\n"), ok);
        assert_eq!(parse_slug("ssh://git@github.com/o/r"), ok);
        assert_eq!(parse_slug("https://evilgithub.com/o/r"), None);
        assert_eq!(parse_slug("https://github.com.evil.io/o/r"), None);
        assert_eq!(parse_slug("https://github.com/o/r/../../x"), None);
        assert_eq!(parse_slug("https://gitlab.com/o/r"), None);
    }
}
