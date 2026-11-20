// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if let Some(code) = gitolotl_lib::cli() {
        std::process::exit(code);
    }
    gitolotl_lib::run()
}
