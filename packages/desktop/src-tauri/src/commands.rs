use crate::config::{self, Config};
use std::path::PathBuf;
use tauri::{AppHandle, Manager, Runtime};

fn config_path<R: Runtime>(app: &AppHandle<R>) -> PathBuf {
    app.path()
        .app_config_dir()
        .expect("no app config dir")
        .join("config.json")
}

pub fn navigate_to_hub<R: Runtime>(app: &AppHandle<R>, hub_url: &str) {
    if let Some(win) = app.get_webview_window("main") {
        if let Ok(u) = url::Url::parse(hub_url) {
            let _ = win.navigate(u);
        }
    }
}

#[tauri::command]
pub fn get_hub_url<R: Runtime>(app: AppHandle<R>) -> Option<String> {
    config::load(&config_path(&app)).map(|c| c.hub_url)
}

#[tauri::command]
pub async fn set_hub_url<R: Runtime>(app: AppHandle<R>, url: String) -> Result<(), String> {
    let normalized = config::normalize_url(&url)?;
    // Validate reachability against the hub health endpoint. Async so the 5s
    // timeout never blocks the UI thread (see follow-up #1).
    let health = format!("{normalized}/health");
    let resp = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?
        .get(&health)
        .send()
        .await
        .map_err(|_| "could not reach the hub at that URL".to_string())?;
    if !resp.status().is_success() {
        return Err(format!("hub health check failed ({})", resp.status()));
    }
    config::save(&config_path(&app), &Config { hub_url: normalized.clone() })
        .map_err(|e| e.to_string())?;
    navigate_to_hub(&app, &normalized);
    crate::notify::restart(&app, &normalized); // defined in Task 4; see note
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::config::normalize_url;

    #[test]
    fn command_relies_on_normalize_guard() {
        // The command rejects bad input via normalize_url before any I/O.
        assert!(normalize_url("nonsense").is_err());
        assert_eq!(normalize_url("http://h/").unwrap(), "http://h");
    }
}
