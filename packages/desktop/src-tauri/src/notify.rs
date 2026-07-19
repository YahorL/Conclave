use serde::Deserialize;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_notification::NotificationExt;

#[derive(Debug, Deserialize, PartialEq)]
pub struct NotifyPayload {
    pub title: String,
    pub body: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub tag: String,
}

#[derive(Debug, Deserialize)]
struct NotifyFrame {
    r#type: String,
    payload: NotifyPayload,
}

/// Pull the injected hub token out of the served index.html.
pub fn extract_token(html: &str) -> Option<String> {
    let marker = "__CONCLAVE_TOKEN__";
    let idx = html.find(marker)?;
    let after = &html[idx + marker.len()..];
    let q1 = after.find('"')?;
    let rest = &after[q1 + 1..];
    let q2 = rest.find('"')?;
    let token = &rest[..q2];
    if token.is_empty() || token == "CONCLAVE_TOKEN_PLACEHOLDER" {
        return None;
    }
    Some(token.to_string())
}

/// Parse a ws text frame; return the payload only for `{"type":"notify",…}`.
pub fn parse_frame(text: &str) -> Option<NotifyPayload> {
    let frame: NotifyFrame = serde_json::from_str(text).ok()?;
    if frame.r#type != "notify" {
        return None;
    }
    Some(frame.payload)
}

// Holds the abort handle for the current notify task so restart() can cancel it.
static TASK: Mutex<Option<tauri::async_runtime::JoinHandle<()>>> = Mutex::new(None);

/// Cancel any running notify loop and spawn a fresh one for `hub_url`.
pub fn restart<R: Runtime>(app: &AppHandle<R>, hub_url: &str) {
    let mut guard = TASK.lock().unwrap();
    if let Some(handle) = guard.take() {
        handle.abort();
    }
    let app = app.clone();
    let hub_url = hub_url.to_string();
    *guard = Some(tauri::async_runtime::spawn(async move {
        run_loop(app, hub_url).await;
    }));
}

async fn run_loop<R: Runtime>(app: AppHandle<R>, hub_url: String) {
    let mut backoff = 1u64;
    loop {
        match connect_once(&app, &hub_url).await {
            Ok(()) => backoff = 1,
            Err(e) => {
                eprintln!("conclave notify: {e}");
            }
        }
        tokio::time::sleep(std::time::Duration::from_secs(backoff)).await;
        backoff = (backoff * 2).min(30);
    }
}

async fn connect_once<R: Runtime>(app: &AppHandle<R>, hub_url: &str) -> Result<(), String> {
    use futures_util::StreamExt;

    let html = reqwest::get(format!("{hub_url}/"))
        .await
        .map_err(|e| e.to_string())?
        .text()
        .await
        .map_err(|e| e.to_string())?;
    let token = extract_token(&html).ok_or("no token in served page")?;

    let ws_url = {
        let mut u = url::Url::parse(hub_url).map_err(|e| e.to_string())?;
        match u.scheme() {
            "https" => u.set_scheme("wss").ok(),
            _ => u.set_scheme("ws").ok(),
        };
        u.set_path("/ws");
        u.set_query(Some(&format!("token={token}")));
        u.to_string()
    };

    let (mut stream, _resp) = tokio_tungstenite::connect_async(&ws_url)
        .await
        .map_err(|e| e.to_string())?;

    while let Some(msg) = stream.next().await {
        let msg = msg.map_err(|e| e.to_string())?;
        if let tokio_tungstenite::tungstenite::Message::Text(text) = msg {
            if let Some(payload) = parse_frame(&text) {
                show_notification(app, &payload, hub_url);
            }
        }
    }
    Ok(())
}

fn show_notification<R: Runtime>(app: &AppHandle<R>, payload: &NotifyPayload, hub_url: &str) {
    let _ = app
        .notification()
        .builder()
        .title(&payload.title)
        .body(&payload.body)
        .show();
    // Deep-link on the next window show is best-effort: store the target so a
    // click handler (or the user reopening) lands on the right thread. For the
    // MVP we navigate immediately if a url is present, matching the ?thread= flow.
    if !payload.url.is_empty() {
        if let Some(win) = app.get_webview_window("main") {
            if let Ok(u) = url::Url::parse(&format!("{hub_url}{}", payload.url)) {
                let _ = win.navigate(u);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_real_token_ignoring_placeholder() {
        let html = r#"<script>window.__CONCLAVE_TOKEN__ = "abc123";</script>"#;
        assert_eq!(extract_token(html), Some("abc123".to_string()));
        let placeholder = r#"window.__CONCLAVE_TOKEN__ = "CONCLAVE_TOKEN_PLACEHOLDER";"#;
        assert_eq!(extract_token(placeholder), None);
        assert_eq!(extract_token("no token here"), None);
    }

    #[test]
    fn parses_only_notify_frames() {
        let ok = r#"{"type":"notify","payload":{"title":"T","body":"B","url":"/?thread=x","tag":"g"}}"#;
        assert_eq!(
            parse_frame(ok),
            Some(NotifyPayload { title: "T".into(), body: "B".into(), url: "/?thread=x".into(), tag: "g".into() })
        );
        assert!(parse_frame(r#"{"type":"usage","summary":{}}"#).is_none());
        assert!(parse_frame("not json").is_none());
    }
}
