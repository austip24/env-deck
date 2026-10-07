mod azure;
mod cli;
mod commands;
mod envfile;
mod error;
mod fsops;
mod github;
mod manifest;
mod scan;
mod state;
mod update;
mod watch;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            commands::init_state(app.handle());
            update::init(app.handle());
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
            commands::github_repo,
            commands::github_inspect,
            commands::github_push,
            commands::github_open_page,
            commands::azure_hint,
            commands::azure_account,
            commands::azure_list_apps,
            commands::azure_list_slots,
            commands::azure_inspect,
            commands::azure_push,
            commands::azure_open_portal,
            commands::check_update,
            commands::install_update,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
