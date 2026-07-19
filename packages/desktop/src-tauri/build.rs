fn main() {
    // Opt the two custom hub-url commands into the ACL/capability system.
    //
    // By default Tauri allows every custom command from every window/webview
    // (local AND remote origins are only auto-denied when NO app manifest is
    // present, but local origins are auto-allowed). Listing the commands here
    // sets `has_app_acl_manifest = true`, which forces the runtime authority to
    // require an explicit capability grant for these commands from *local*
    // origins too — so the grant in `capabilities/launcher.json` becomes real,
    // enforced allowlisting rather than a decorative no-op. Remote origins
    // (the hub page, once the window navigates there) are denied regardless,
    // because no capability lists them under a `remote` allowlist.
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&["get_hub_url", "set_hub_url"]),
        ),
    )
    .expect("failed to run tauri-build");
}
