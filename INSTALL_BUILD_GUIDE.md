# Getting XOFT installed as real apps — what's actually true

You have: Android, Windows PC, Linux. No Mac. Backend maybe on Vercel.
Here's the real state of each piece and what to do next.

## 1. Backend deployment — Vercel won't work for this

xoft-core is a long-running Express server with in-memory managers (device
registry, event bus, background jobs, monitors) and a SQLite file on disk.
Vercel runs your code as short-lived serverless functions with no persistent
disk and no long-running process — the server would lose all in-memory
state (and its whole SQLite file) between requests, and background jobs
would just never run. This isn't a config tweak; the architecture doesn't
fit that model.

Use something that runs one process continuously instead:
- **Railway** or **Render** — easiest, ~5 min setup, persistent disk add-on
  for the SQLite file, free/cheap tier
- **Fly.io** — same idea, a bit more control
- A cheap VPS (DigitalOcean, Hetzner) if you want full control

Any of these: `npm ci --ignore-scripts --no-audit --no-fund && npm run verify:deps && npm start`.
Set `AUTH_API_KEYS` before it's reachable publicly (see DEPLOYMENT.md).

## 2. iOS — genuinely blocked without a Mac, one real workaround

Apple requires Xcode on macOS to build and sign an iOS app — no tool,
including me, can get around that. There's no iOS source in this project
yet anyway (only `apps/mobile`, a React Native scaffold with no `ios/`
folder generated).

The real workaround if you don't want to buy a Mac: a cloud Mac CI service
builds and signs it for you from your existing source —
**Expo EAS Build** (if you go the Expo route) or **Codemagic** both run
macOS runners in the cloud and hand you a signed `.ipa`. Still needs an
Apple Developer account ($99/yr) to actually distribute it, even via
TestFlight. Worth revisiting once Android + desktop are solid — same
React Native code would target iOS too.

## 3. Android — buildable, but needs Android Studio on your PC

`android-companion` is real native Kotlin (accessibility service, notification
listener, app control) — not a stub. What was missing: the Gradle wrapper
jar. I added `gradle/wrapper/gradle-wrapper.properties` pointing at Gradle
8.9 (matches the AGP 8.5.2 / Kotlin 2.0.21 versions already in the project),
but I can't fetch the wrapper `.jar` binary itself from this sandbox (no
network path to services.gradle.org here).

On your Windows or Linux PC:
1. Install **Android Studio** (bundles the JDK + SDK you need)
2. Open the `android-companion/` folder — Android Studio detects the
   missing wrapper jar and offers to regenerate it automatically ("Sync
   Project with Gradle Files" if it doesn't prompt)
3. Build → Build Bundle/APK → Build APK(s)
4. Copy the resulting `.apk` to your phone and install (enable "install
   from unknown sources" once) — or `adb install app-debug.apk` over USB

Point the app at your deployed backend URL via `XoftConfig.kt` before building.

## 4. Desktop (Windows + Linux) — buildable via Tauri, needs Rust

`apps/desktop` is a real Tauri 2 + Vite scaffold. Tauri compiles your web
UI into a native binary (`.exe` / `.deb` / `.AppImage`) — it needs the
**Rust toolchain**, which this sandbox only has an old apt-packaged version
of (1.75, likely below Tauri 2's minimum) and can't upgrade without network
access this container doesn't have to rustup's servers. Build it locally
instead — much more reliable there anyway since you're building the
actual target binary for your own OS:

**On Windows or Linux:**
```bash
# one-time: install Rust from https://rustup.rs
cd apps/desktop
npm install
npm run tauri build
```
Output: a native installer under `apps/desktop/src-tauri/target/release/bundle/`
(`.msi`/`.exe` on Windows, `.deb`/`.AppImage` on Linux). Run it once on each
OS you want an installer for — Tauri builds for the OS it's run on, no
cross-compiling both from one machine without extra setup.

## Suggested order
1. Deploy backend to Railway/Render (10 min)
2. Desktop build on your Linux box, then your Windows box (Rust + `tauri build`)
3. Android build in Android Studio once you're back at a PC with it installed
4. iOS later, via Codemagic/EAS, once 2–3 are working and you're ready to pay for an Apple Developer account
