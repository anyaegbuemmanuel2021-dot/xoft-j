# XOFT Universal Architecture

XOFT is now organized around one cross-platform protocol rather than separate product-specific agents.

## Layers

- `src/` — existing XOFT Core intelligence/orchestration backend.
- `packages/xoft-protocol` — TypeScript contracts shared by clients.
- `apps/mobile` — React Native client for Android and iOS.
- `apps/desktop` — Tauri 2 client for Windows and Linux (and extensible to macOS).

## Principle

Shared TypeScript owns protocol, UI state, API clients, device capabilities and command envelopes. Native layers own operations that require operating-system privileges.

Android/iOS: React Native modules/native services.
Windows/Linux: Tauri commands/Rust.

The Core remains the authority for identity, permissions, approvals, risk and command routing. A client never bypasses OS permission controls.

## Migration status

The previous Kotlin Android companion and Node PC agent are retained as compatibility/reference implementations. The new Universal clients are the forward architecture. Capability parity should be migrated incrementally, not by deleting the working legacy agents first.
