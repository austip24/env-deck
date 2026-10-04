// TODO(M4): remove these `allow`s once commands.rs uses the core modules; until then only
// tests do.
mod commands;
#[allow(dead_code)]
mod envfile;
#[allow(dead_code)]
mod error;
#[allow(dead_code)]
mod fsops;
#[allow(dead_code)]
mod manifest;
mod scan;
#[allow(dead_code)]
mod state;
mod watch;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
