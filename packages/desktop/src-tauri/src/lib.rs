mod commands;
mod config;
mod notify;

use std::sync::Mutex;

// The real launcher/bundled-frontend origin, captured at startup. The tray
// "Change hub URL…" handler reuses this instead of a hardcoded scheme literal,
// which differs by platform (e.g. Linux `http://tauri.localhost`).
static LAUNCHER_URL: Mutex<Option<String>> = Mutex::new(None);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use tauri::{
        menu::{Menu, MenuItem},
        tray::{TrayIconBuilder, TrayIconEvent},
        Manager, WindowEvent,
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            commands::get_hub_url,
            commands::set_hub_url
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            // Tray menu: Show/Hide, Change hub URL…, Quit.
            let show = MenuItem::with_id(app, "show", "Show / Hide", true, None::<&str>)?;
            let change = MenuItem::with_id(app, "change", "Change hub URL…", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &change, &quit])?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(win) = app.get_webview_window("main") {
                            if win.is_visible().unwrap_or(false) {
                                let _ = win.hide();
                            } else {
                                let _ = win.show();
                                let _ = win.set_focus();
                            }
                        }
                    }
                    "change" => {
                        if let Some(win) = app.get_webview_window("main") {
                            // Navigate back to the real launcher origin captured at
                            // startup; fall back to the literal if it wasn't stored.
                            let stored = LAUNCHER_URL.lock().unwrap().clone();
                            let target = stored
                                .as_deref()
                                .and_then(|s| s.parse::<url::Url>().ok())
                                .or_else(|| "tauri://localhost".parse::<url::Url>().ok());
                            if let Some(u) = target {
                                let _ = win.navigate(u);
                            }
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { .. } = event {
                        if let Some(win) = tray.app_handle().get_webview_window("main") {
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                    }
                })
                .build(app)?;

            // Capture the real launcher origin BEFORE any config-based navigation,
            // so the tray "change" handler can return here regardless of platform.
            if let Some(win) = app.get_webview_window("main") {
                if let Ok(u) = win.url() {
                    *LAUNCHER_URL.lock().unwrap() = Some(u.to_string());
                }
            }

            // Load persisted hub URL and route the window.
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
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
