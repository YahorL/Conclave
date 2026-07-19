use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Config {
    pub hub_url: String,
}

/// Trim, strip trailing slashes, and require an http(s) scheme.
pub fn normalize_url(raw: &str) -> Result<String, String> {
    let t = raw.trim();
    if t.is_empty() {
        return Err("hub URL is empty".into());
    }
    let parsed = url::Url::parse(t).map_err(|_| "not a valid URL".to_string())?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("URL must start with http:// or https://".into());
    }
    Ok(t.trim_end_matches('/').to_string())
}

pub fn load(path: &Path) -> Option<Config> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

pub fn save(path: &Path, config: &Config) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, serde_json::to_string_pretty(config).unwrap())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_strips_trailing_slash_and_trims() {
        assert_eq!(normalize_url("  http://localhost:8787/  ").unwrap(), "http://localhost:8787");
        assert_eq!(normalize_url("https://hub.example").unwrap(), "https://hub.example");
    }

    #[test]
    fn normalize_rejects_bad_scheme_and_empty() {
        assert!(normalize_url("ftp://x").is_err());
        assert!(normalize_url("localhost:8787").is_err());
        assert!(normalize_url("   ").is_err());
    }

    #[test]
    fn save_then_load_round_trips() {
        let dir = std::env::temp_dir().join(format!("conclave-cfg-{}", std::process::id()));
        let path = dir.join("config.json");
        let cfg = Config { hub_url: "http://localhost:8787".into() };
        save(&path, &cfg).unwrap();
        assert_eq!(load(&path), Some(cfg));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_missing_or_corrupt_returns_none() {
        assert_eq!(load(Path::new("/nonexistent/conclave/config.json")), None);
        let dir = std::env::temp_dir().join(format!("conclave-corrupt-{}", std::process::id()));
        let path = dir.join("config.json");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&path, "not json").unwrap();
        assert_eq!(load(&path), None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
