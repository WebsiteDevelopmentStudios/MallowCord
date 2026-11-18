use std::{fs, path::Path};

fn main() {
    // Tauri's Windows resource compiler expects icons/icon.ico even when
    // bundle.icon is empty. Generate a tiny valid fallback icon at build time
    // so the repository does not need to store a binary asset.
    let icon_dir = Path::new("icons");
    fs::create_dir_all(icon_dir).expect("create icon directory");

    let mut ico: Vec<u8> = Vec::with_capacity(70);
    // ICONDIR
    ico.extend_from_slice(&[0, 0, 1, 0, 1, 0]);
    // ICONDIRENTRY: 1x1, 32-bit, 48-byte image at offset 22
    ico.extend_from_slice(&[1, 1, 0, 0, 1, 0, 32, 0]);
    ico.extend_from_slice(&48u32.to_le_bytes());
    ico.extend_from_slice(&22u32.to_le_bytes());
    // BITMAPINFOHEADER + one opaque purple pixel + padded AND mask
    ico.extend_from_slice(&40u32.to_le_bytes());
    ico.extend_from_slice(&1i32.to_le_bytes());
    ico.extend_from_slice(&2i32.to_le_bytes());
    ico.extend_from_slice(&1u16.to_le_bytes());
    ico.extend_from_slice(&32u16.to_le_bytes());
    ico.extend_from_slice(&0u32.to_le_bytes());
    ico.extend_from_slice(&4u32.to_le_bytes());
    ico.extend_from_slice(&[0u8; 16]);
    ico.extend_from_slice(&[160, 90, 190, 255]);
    ico.extend_from_slice(&[0u8; 4]);

    fs::write(icon_dir.join("icon.ico"), ico).expect("write fallback Windows icon");
    println!("cargo:rerun-if-changed=build.rs");
    tauri_build::build()
}
