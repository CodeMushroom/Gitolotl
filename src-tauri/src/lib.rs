mod git;
mod github;

/// `gitolotl <folder>` opens that repository on launch.
#[tauri::command]
fn initial_repo() -> Option<String> {
    std::env::args()
        .nth(1)
        .filter(|p| !p.starts_with('-') && std::path::Path::new(p).is_dir())
}

/// `gitolotl snapshot [folder]` takes a safety snapshot and exits, without
/// opening a window. Intended for scripts and AI agents to call before they
/// start changing files. Returns the process exit code when it handled the call.
pub fn cli() -> Option<i32> {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) != Some("snapshot") {
        return None;
    }
    let folder = args
        .get(2)
        .cloned()
        .or_else(|| std::env::current_dir().ok().map(|p| p.to_string_lossy().into_owned()))
        .unwrap_or_default();
    Some(match git::snapshot_now(&folder) {
        Ok(Some(hash)) => {
            println!("{hash}");
            0
        }
        Ok(None) => {
            println!("clean");
            0
        }
        Err(e) => {
            eprintln!("gitolotl snapshot: {e}");
            1
        }
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            initial_repo,
            git::repo_open,
            git::repo_init,
            git::repo_clone,
            git::get_status,
            git::get_log,
            git::get_refs,
            git::get_remotes,
            git::get_stashes,
            git::get_commit_details,
            git::get_diff,
            git::get_blame,
            git::get_patch,
            git::get_worktrees,
            git::get_backups,
            git::delete_backup,
            git::restore_backup,
            git::get_conflict,
            git::resolve_with_content,
            git::get_worktree_details,
            git::add_worktree,
            git::remove_worktree,
            git::get_unpushed,
            git::stage,
            git::stage_all,
            git::unstage,
            git::unstage_all,
            git::discard,
            git::apply_patch,
            git::commit,
            git::last_commit_message,
            git::resolve_conflict,
            git::checkout,
            git::create_branch,
            git::default_branch,
            git::delete_branch,
            git::rename_branch,
            git::delete_remote_branch,
            git::create_tag,
            git::delete_tag,
            git::merge,
            git::rebase,
            git::cherry_pick,
            git::revert,
            git::reset,
            git::op_continue,
            git::op_abort,
            git::op_skip,
            git::rebase_candidates,
            git::rebase_interactive,
            git::fetch,
            git::pull,
            git::push,
            git::add_remote,
            git::remove_remote,
            git::stash_push,
            git::stash_op,
            git::get_identity,
            git::set_identity,
            github::github_info,
            github::github_prs,
            github::github_create_pr,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Gitolotl");
}
