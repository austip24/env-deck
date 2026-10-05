fn main() {
    // The EnvDeck GitHub App's client ID and slug are compiled in (github_auth.rs).
    println!("cargo:rerun-if-env-changed=ENVDECK_GITHUB_CLIENT_ID");
    println!("cargo:rerun-if-env-changed=ENVDECK_GITHUB_APP_SLUG");
    tauri_build::build()
}
