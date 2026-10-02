fn main() {
    println!("cargo:rerun-if-changed=ios/Sources/MobilePushPlugin.swift");
    println!("cargo:rerun-if-changed=ios/Package.swift");
    println!("cargo:rerun-if-changed=android/src/main/java/app/tauri/mobilepush/MobilePushPlugin.kt");

    tauri_plugin::Builder::new(&[
        "request_permission",
        "get_token",
        "register_listener",
        "remove_listener",
    ])
    .android_path("android")
    .ios_path("ios")
    .build();
}
