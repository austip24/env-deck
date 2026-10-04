mod commands;
mod envfile;
mod error;
mod fsops;
mod manifest;
mod scan;
mod state;
mod watch;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            commands::init_state(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_manifest,
            commands::reload_manifest,
            commands::save_manifest,
            commands::add_folder,
            commands::save_folder,
            commands::remove_folder,
            commands::set_library,
            commands::scan,
            commands::read_config,
            commands::write_config,
            commands::set_env_vars,
            commands::pick_destination,
            commands::copy_config,
            commands::create_from_template,
            commands::copy_files_to_clipboard,
            commands::reveal,
            commands::start_drag,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
