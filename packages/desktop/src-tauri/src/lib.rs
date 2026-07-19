mod commands;
mod config;
mod notify;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            commands::get_hub_url,
            commands::set_hub_url
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let path = app
                .path()
                .app_config_dir()
                .expect("no app config dir")
                .join("config.json");
            if let Some(cfg) = config::load(&path) {
                commands::navigate_to_hub(&handle, &cfg.hub_url);
                notify::restart(&handle, &cfg.hub_url);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
