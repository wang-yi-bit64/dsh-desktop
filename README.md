# DSH Desktop (Tauri)

> [中文文档 (Chinese)](README.zh-CN.md)

A desktop window shell for [DeepSeek Harness](https://github.com/deepseek-ai/dsh) rebuilt with **Rust + Tauri 2.0**.

This project is a from-scratch Rust/Tauri port of the Electron-based `dataelement/dsh-desktop` wrapper. It mimics the original's behavior so the desktop app and the Harness web UI stay feature-identical, while replacing the heavy Electron runtime with a much slimmer, faster Tauri shell.

## Features

> **Status legend**: ✅ wired (on the runtime path) · ⚠️ not wired (implemented and tested, but no runtime caller) · 🟡 partial · ❌ not implemented.
> Code evidence and call sites for every row live in [`AGENTS.md` §7 Claim Discipline](AGENTS.md#7-宣称纪律claim-discipline). This file and AGENTS.md must agree; changing one means changing the other.

### Wired capabilities

- **Bundled Runtime** ✅ — Ships its own Node.js (v24) and the full `@deepseek-ai/dsh` dependency tree, so no Node.js is required on the host system.
- **Dedicated Contracts & Protocol Types (`dsh-contracts`)** ✅ — Clean separation of universal constants, error code taxonomies (`E1001`~`E4002`), IPC Envelopes (`IpcEnvelope<T>`), and JSON-RPC 2.0 protocol specifications (single source of truth; downstream crates such as `dsh-host` re-export instead of redefining) without GUI or platform bloat.
- **Harness Subprocess Lifecycle** ✅ — Spawns Harness on a reserved loopback port, extracts per-process launch tokens, and polls HTTP readiness.
- **Watchdog & Crash Self-Healing (Supervisor)** ✅ — Embedded supervisor state machine with heartbeat checks, automatic restarts, and circuit breaking.
- **Orphan Process Protection (INV-3)** ✅ — Win32 JobObject (`KILL_ON_JOB_CLOSE`) on Windows, `PR_SET_PDEATHSIG` + process groups on Linux, process groups + exit sweeping on macOS. No child survives a hard crash or exit of the shell.
- **In-Process Plugin Fault Guard** ✅ — `plugin-safety-guard.mjs` intercepts uncaught exceptions and unhandled rejections, emitting `[dsh-plugin-fault]` attribution so one plugin cannot take down the whole Harness.
- **Safe Mode & Recovery** ✅ — Detects the startup failure cause and writes an isolated profile, then **actually boots Harness with it** (`--profile desktop-safe-mode` plus `dsh-desktop-safe.patch.yml`, which drops the product plugins that the normal patch layer mounts) so basic functionality stays available. Note: the shell gives no in-app indication that safe mode is active.
- **Multi-Profile & Session Management** ✅ — Built-in Session and Profile managers for managing persistent configuration, environment variables, and metadata.
- **Structured Shell Logging** ✅ — `tauri-plugin-log` writes to `app_data_dir/desktop.log` (5 MB × 2 rotations, local timezone), kept separate from Harness-side `harness.log` / `app.log` so you can tell "shell problem" from "Harness problem".
- **Mobile Bridge** ✅ — LAN HTTP server with a pairing page (QR code + pairing token) forwarding RPC to Harness. It does **not** listen by default: you must start it explicitly from the application menu ("Phone Pairing (LAN)"). Access is constrained by the Harness `dsh-auth-*` cookie handshake plus a session token, both revoked on stop. The menu's `Phone` submenu shows live bridge state (off / listening / paired) — note the app has **no system tray yet**.
- **Desktop Customization** ✅ — Desktop brand assets and UI behaviors applied through `patch-package` patches and `patch.yml` passed to `web --patch`. Patches are tiered as `functional` / `ui-behavior` / `brand` (see [`patches/LAYERS.md`](patches/LAYERS.md)); failures degrade by default and are recorded per-patch in `MANIFEST.json` → `patches[]`, while `--strict` restores full fail-fast behaviour.
- **Single Instance** ✅ — Second launches focus the existing window instead of duplicating processes.
- **Microsecond Benchmark Suite** ✅ — The `dsh-model-gateway` benchmark measures schema sanitization and multi-provider dialect conversion at ~2–20 µs (runnable, but see the "not wired" note below).

### Not wired / not implemented (experimental — do not claim as usable)

- **Tier 0/1/2 Plugin Process Isolation 2.0** ⚠️ **not wired** — The tiered sandbox host (`plugin-worker-host.mjs`), JSON-RPC 2.0 transport, execution timeouts, error trip-wires, and circuit breaker (`plugin_worker.rs`) are **all implemented and unit-tested**, but **nothing in this repository calls them**: the Node-side `PluginWorkerClient` is deliberately discarded, and the Rust-side `call_tool` now returns an identifiable `ISOLATION_NOT_WIRED` error instead of forging success. **The only plugin protection actually in effect is the in-process guard listed above** — a crash inside that process can still take Harness down. Wiring prerequisites and exit criteria: [`docs/plugin_isolation_architecture.md`](docs/plugin_isolation_architecture.md).
- **Multi-Model Tool Gateway 2.0 (`dsh-model-gateway`)** ⚠️ **not wired** — Schema validation, `anyOf`/`oneOf` sanitization, and multi-provider (OpenAI/DeepSeek/Gemini/Claude) dialect adaptation are implemented and tested, but there is **no runtime consumer**; since 2026-09-10 it is **no longer a dependency of `src-tauri`**. It is retained as an independently testable asset — see the status table at the top of [`docs/model_gateway_design.md`](docs/model_gateway_design.md) for the wire-it-or-freeze-it criteria.
- **Shell UI & Error Attribution** 🟡 **partial** — The splash screen and error page (fault attribution, one-click retry, Safe Mode switch) **are** wired; however **one-click redacted diagnostic exports (`diagnostics.zip`) are not implemented** — no such code exists in the repository. The two available ways to collect diagnostic evidence today are `dsh-host-cli doctor` and the shell log `desktop.log`.
- **Automatic Updates** 🟡 **wired, but the release source must change** — `tauri-plugin-updater` is registered and the check/download/restart-to-install flow works; but `tauri.conf.json` → `plugins.updater.endpoints` **still points at the upstream `dataelement/dsh-desktop` releases**, and the `pubkey` is not ours. Until it points at this repository with our own signing key, **do not ship a release build with the updater enabled**.

## Prerequisites

- [Rust toolchain](https://rustup.rs/) (stable, `>= 1.85` recommended)
- [Node.js](https://nodejs.org/) (v18+; used for build scripts and packaging tooling)
- Platform build prerequisites for [Tauri v2](https://v2.tauri.app/start/prerequisites/) (WebView2 / WebKit / WebKitGTK as appropriate).

## Getting Started

```sh
npm install
npm run dev
```

`npm run dev` first assembles the Harness runtime into `src-tauri/resources/` (see [`scripts/prepare-harness.mjs`](scripts/prepare-harness.mjs)), then starts the desktop application.

To build an installer or production release:

```sh
npm run build
# or invoke directly:
npm run tauri build
```

## Repository & Workspace Layout

```text
crates/
  dsh-contracts/        # Pure Rust universal contracts (constants, errors, IPC envelope, JSON-RPC, lifecycle, diagnostics)
  dsh-host/             # Headless core host library (process management, supervisor, crash diagnostics, log ring buffer; plugin isolation is state machine only, NOT wired)
  dsh-host-cli/         # Command-line interface for dsh-host (start / status / stop / tail / doctor)
  dsh-model-gateway/    # Multi-provider tool schema sanitizer, validator, benchmark suite, adapter gateway — NOT wired, not a src-tauri dependency
src-tauri/
  frontend/             # Shell web pages (splash, error attribution, safe-mode indicator)
  resources/            # Assembled Harness runtime + brand assets (gitignored, generated by build scripts)
  src/                  # Tauri desktop layer (window management, application menu, IPC commands, Safe Mode, LAN mobile bridge, shell logging, updates)
    logging.rs              # Shell structured logging (desktop.log, 5 MB x 2 rotations)
    mobile_bridge.rs        # LAN mobile bridge (pairing page + dsh-auth-* cookie handshake + RPC forwarding)
build/                  # Runtime injection and guard scripts
  harness-node-entry.mjs    # Node entry adapter (also the cold-start projection and fault-attribution wiring point)
  plugin-safety-guard.mjs   # Global unhandled exception / promise rejection guard (formatFaultDetails wired; PluginWorkerClient NOT wired)
  plugin-worker-host.mjs    # Worker thread isolation host for plugins with JSON-RPC 2.0 support — NOT wired
patches/                # patch-package patches applied to the Harness tree + LAYERS.md tier manifest
vendor/                 # Local desktop customization packages (dshmarket, etc.)
packages/               # Vendored tgz overrides for patched packages
scripts/                # Build and testing helpers (prepare-harness, stub-tauri-resources, etc.)
  prepare-harness.mjs       # Assembles the bundled runtime into src-tauri/resources/ (tiered patch degradation; --strict restores fail-fast)
  stub-tauri-resources.mjs  # Compile-only stub resources for fresh checkouts / CI
  mock-harness.mjs          # Fault-injectable fake Harness used by integration tests
  fault-inject.mjs          # Orphan-process and failure-attribution verification
  patch-layers.mjs          # Single source of truth for patch tiers (--self-test / --list)
  smoke-launch.mjs          # Layered CI smoke (L1 headless gate / L2 GUI under xvfb)
  report-bundle-size.mjs    # Collects shell / installer / resource-tree sizes into the CI job summary
docs/                   # Architecture designs, contract definitions, and specifications
  dsh-desktop-redesign-architecture-and-plan.md  # Comprehensive redesign architecture & execution plan
  system_design.md                  # Core system design & invariant specifications
  model_gateway_design.md           # Model gateway architecture and tool calling conversions (includes not-wired status and exit criteria)
  plugin_isolation_architecture.md  # Worker thread plugin isolation architecture and RPC protocol (includes not-wired status)
  dsh-upgrade-checklist.md          # DSH upstream upgrade checklist (patch regeneration -> gates -> 3-platform smoke)
  harness-packaging-and-compatibility.md  # Long-term plan for artifact slimming and patch fragility governance
```

## Architecture & Roadmap

The left column is the **design scope**; the right column is **whether it is currently on the runtime path**. The two are not interchangeable (see [`AGENTS.md` §7](AGENTS.md#7-宣称纪律claim-discipline)).

| Phase | Designed scope | Current status |
|-------|---------------|----------------|
| P0 | Contracts crate (`dsh-contracts`), error taxonomies, orphan process protection (Win32 Job Objects / POSIX process groups), headless core crates (`dsh-host`, `dsh-host-cli`) | ✅ wired |
| P1 | Supervisor state machine and self-healing, ring-buffer log persistence, crash attribution analysis, Safe Mode recovery profiles | ✅ wired |
| P2 | Decoupled worker/subprocess sandbox host (`plugin-worker-host.mjs`), JSON-RPC 2.0 transport, error trip-wires, circuit breaker (`plugin_worker.rs`) | ⚠️ **not wired** — implemented and unit-tested, but no runtime caller; `call_tool` returns `ISOLATION_NOT_WIRED` instead of forging success |
| P3 | Multi-provider schema sanitization, complex union normalization (`anyOf`/`oneOf`), payload adaptation (`dsh-model-gateway`), microsecond benchmarks | ⚠️ **not wired** — removed from `src-tauri` dependencies; no runtime consumer |
| P4 | Unified `IpcEnvelope<T>` responses in Tauri commands; one-click redacted diagnostic exports (`diagnostics.zip`) | 🟡 envelope ⚠️ **not wired** (contract defined, 16 commands still return `Result<T, String>`); **diagnostics export ❌ not implemented** |

### Planned (not started)

- **P2/P3 wire-or-freeze decision** — give plugin isolation and the model gateway an explicit verdict ("integrate into the runtime" or "freeze as an asset") instead of leaving them indefinitely in the "implemented but unused" middle state.
- **Release source switch** — repoint the updater endpoint from upstream `dataelement/dsh-desktop` to this repository and generate our own minisign key pair.
- **Diagnostics bundle** — build redacted packaging (logs + attribution verdict + environment snapshot + `MANIFEST.json`) on top of the existing `dsh-host-cli doctor` capability.

## Testing

The headless gate runs without a display and without the 300 MB assembled runtime (INV-6):

```sh
cargo test -p dsh-contracts -p dsh-host -p dsh-host-cli -p dsh-model-gateway
```

Integration tests spawn a real Node process running `scripts/mock-harness.mjs`, so they need a Node.js binary on `PATH` (override with `DSH_TEST_NODE`) and skip themselves cleanly when none is found. Failure modes — startup failure, missing URL, port-in-use retry, post-ready crash — are injected through `mock-harness.mjs` argv and environment variables rather than mocked in Rust. `scripts/fault-inject.mjs` additionally verifies orphan-process cleanup and exit-code attribution against `dsh-host-cli`.

## Notes

- `node_modules/`, `harness-deps/`, `src-tauri/target/`, and `src-tauri/resources/` are gitignored; `resources/` is generated by the build script to avoid repository bloat.
- On fresh checkouts without bundled resources, run `node scripts/stub-tauri-resources.mjs` before running `cargo check` or `cargo test` to generate dummy resources for Tauri's compile-time validation.
- **Updater source (🔴 must change)**: `tauri.conf.json` → `plugins.updater.endpoints` **currently points at the upstream `dataelement/dsh-desktop` releases**, and the `pubkey` belongs to that project, not to us. In other words, as shipped today the auto-updater would check another project's release artifacts — **do not rely on that channel, and do not ship a release build with the updater enabled, until it points at this repository with our own minisign key pair.**

## Bundle Size & Expectation Management

Installer size is dominated by the **bundled Node.js runtime plus the full Harness dependency tree**; the shell (Rust/Tauri) itself contributes little. This is not a "bloated shell" problem — it is the unavoidable cost of the "zero host dependencies" promise. Stating that premise is more useful than quoting one vague MB figure.

Size data is collected by `scripts/report-bundle-size.mjs` after a build and written to the CI job summary, so the numbers in this README cannot silently drift. Three distinct measurements:

| Measurement | What it is | What drives it |
|-------------|-----------|----------------|
| Shell binary | `src-tauri/target/release/*.exe` (unpackaged) | Rust dependencies and LTO settings; unrelated to Harness |
| Installer | NSIS `*-setup.exe` | Shell binary + compressed resource tree |
| Resource tree | `src-tauri/resources/` (uncompressed) | Node runtime + `harness/node_modules` dependency tree; **the dominant term** |

> For actual values, run `node scripts/report-bundle-size.mjs` after `npm run build` (or check the CI build job summary). This README intentionally does not maintain hand-written numbers that go stale.

If significant slimming is needed, the lever is reducing what gets packaged into `resources/` (see [`docs/harness-packaging-and-compatibility.md`](docs/harness-packaging-and-compatibility.md)) — not changing Tauri-side configuration, whose effect on the total is single-digit MB.

## Windows Packaging Notes

Three defects previously caused a Windows build to produce an installer whose app never started. All are fixed; this section records the root causes so they are not reintroduced.

- **`\\?\` verbatim paths must never reach the Node child process.** Tauri's `resource_dir()` derives from `current_exe().canonicalize()`, which on Windows returns an extended-length path (`\\?\D:\…`). Concatenating that into the Node entry script makes the CJS loader resolve it back to the bare drive (`D:`) and `lstat` fails with `EISDIR: illegal operation on a directory, lstat 'D:'`. `Layout::resolve` in [`crates/dsh-host/src/paths.rs`](crates/dsh-host/src/paths.rs) strips the prefix at the single point where all derived paths are built, so no call site can leak it.
- **The `prepare:harness` idempotency fast path validates the full bundle manifest.** It previously checked only three files, so a `resources/` tree missing `bin/`, `plugin-safety-guard.mjs`, or `plugin-worker-host.mjs` was accepted as complete and the build was skipped. `plugin-safety-guard.mjs` is imported directly by `harness-node-entry.mjs`, so a package missing it cannot start Harness at all; a missing `bin/` also makes `cargo build` fail on the `resources/bin/*` glob. The completeness check now mirrors `tauri.conf.json` → `bundle.resources`.
- **`shell == None` still goes through `harness_env`.** `Launcher::execute` previously handed the raw `capture_shell_environment()` result to the child, so contract variables such as `DSH_HOME` were never injected. Harness then fell back to `~/.dsh`, writing mutable state outside `app_data_dir` (an INV-1 violation). The GUI and CLI paths now both inject the contract environment.

Separately, the workspace directory picker must go through the Host seam and never a renderer global bridge. A Tauri webview has no preload or initialization script, so no `window.*` global is ever defined there. A `patch-package` patch once rewrote the native picker to call `window.dshDesktopDirectoryPicker.pick()`; that global existed nowhere, so importing a project always failed with "无法打开文件夹 / DSH Desktop directory picker bridge is unavailable". The patch is gone and the stock path is restored: the client calls `ctx.uiWorkspace.pickDirectory()` → the Host `ctx.directoryPicker` seam → the Win32 `IFileOpenDialog` opened inside the Harness process. `assertPickerSurfaceIsHostBacked()` in `scripts/prepare-harness.mjs` verifies this after patches apply and fails the build otherwise.

To build a real installer, `npm run tauri build` downloads the NSIS toolchain on first use; on networks that cannot reach GitHub releases the bundling step fails with `timeout: global` even though the `.exe` and resources have already been produced successfully.

## Security Notes

- **Dependabot / RUSTSEC-2024-0429 (GHSA-wrw7-89jp-8q8g)** — `glib 0.18.5` is flagged for an unsoundness in `glib::VariantStrIter`. It is a **Linux-only, transitive** dependency pulled in by Tauri's GTK3 backend, and our codebase never invokes the affected API. The fix will be automatically resolved once upstream Tauri migrates to gtk-rs 0.20+.
