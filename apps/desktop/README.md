# XOFT Universal Desktop Agent

Tauri 2 desktop shell for Windows and Linux. The UI and shared protocol are TypeScript; OS-specific capabilities belong in Rust/Tauri commands so they can be implemented safely per platform.

## Development

```bash
npm install
npm run build
npm run tauri dev
```

The desktop client registers itself with XOFT Core. Native actions should be added as explicit Tauri commands and gated by the Core permission/approval system.
