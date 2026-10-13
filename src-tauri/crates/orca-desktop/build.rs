fn main() {
    let mut attributes = tauri_build::Attributes::new();
    attributes = attributes.config_path("../../tauri.conf.json");
    tauri_build::try_build(attributes).expect("failed to run tauri-build");
}
