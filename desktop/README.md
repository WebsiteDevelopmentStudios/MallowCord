# MallowCord Desktop

This is a Tauri 2 desktop shell for the existing MallowCord web application. It loads
https://mallowcord-web.onrender.com/ in a native Windows WebView window.

The desktop client deliberately reuses the existing website, OAuth providers, Worker API,
and Neon-backed services. It does not copy credentials or introduce a second account system.

## Build locally

Install Rust, Node.js (not needed for this remote-site shell), and the Tauri Windows
prerequisites (Microsoft C++ Build Tools and WebView2), then run:

```powershell
cd desktop
cargo install tauri-cli --version "^2"
cargo tauri build --config src-tauri/tauri.conf.json
```

Installers are produced under `desktop/src-tauri/target/release/bundle/`.

## Automated Windows build

Run **Build MallowCord Desktop** from the repository's GitHub Actions tab. The workflow
builds Windows NSIS and MSI installers and attaches them to a draft GitHub release.
