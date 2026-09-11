# DSH Desktop (Tauri)

> [中文文档 (Chinese)](README.zh-CN.md)

A desktop window shell for [DeepSeek Harness](https://github.com/deepseek-ai/dsh) rebuilt with **Rust + Tauri 2.0**.

This project is a from-scratch Rust/Tauri port of the Electron-based `dataelement/dsh-desktop` wrapper. It mimics the original's behavior so the desktop app and the Harness web UI stay feature-identical, while replacing the heavy Electron runtime with a much slimmer, faster Tauri shell.

## Features

> **Status legend**: ✅ wired (on the runtime path) · ⚠️ not wired (implemented and tested, but no runtime caller) · 🟡 partial · ❌ not implemented · 🗄️ archived (was implemented, now deleted and formally dropped) · 🕓 planned (no code, and deliberately not now).
> Code evidence and call sites for every row live in [`AGENTS.md` §7 Claim Discipline](AGENTS.md#7-宣称纪律claim-discipline). This file and AGENTS.md must agree; changing one means changing the other.
>
> As of the batch A~G close-out on 2026-09-10 there are **no "not wired" rows left**: everything wireable was wired, and everything else was formally archived and deleted. The two remaining "planned" items are decisions with stated reasons, not debts.

### Wired capabilities

- **Bundled Runtime** ✅ — Ships its own Node.js (v24) and the full `@deepseek-ai/dsh` dependency tree, so no Node.js is required on the host system.
- **Dedicated Contracts & Protocol Types (`dsh-contracts`)** ✅ — Clean separation of universal constants, the **standard error-code table (`E1xxx`~`E7xxx`)**, IPC Envelopes (`IpcEnvelope<T>`, whose `error` payload is a typed `AppError`), and JSON-RPC 2.0 protocol specifications (single source of truth; downstream crates such as `dsh-host` re-export instead of redefining) without GUI or platform bloat.
- **Typed IPC Envelope Across the Whole Command Surface** ✅ — All 17 Tauri commands return `IpcEnvelope<T>` (success flag + typed data + machine-readable `error.code` / `error.category`), and every shell page unwraps that envelope. Failures are **not** modelled as rejected promises, so a page can dispatch on the error *category* ("port in use" → retry vs "plugin fault" → Safe Mode) rather than pattern-matching on English prose.
- **Harness Subprocess Lifecycle** ✅ — Spawns Harness on a reserved loopback port, extracts per-process launch tokens, and polls HTTP readiness.
- **Watchdog & Crash Self-Healing (Supervisor)** ✅ — Embedded supervisor state machine with heartbeat checks, automatic restarts, and circuit breaking.
- **Orphan Process Protection (INV-3)** ✅ — Win32 JobObject (`KILL_ON_JOB_CLOSE`) on Windows, `PR_SET_PDEATHSIG` + process groups on Linux, process groups + exit sweeping on macOS. No child survives a hard crash or exit of the shell.
- **In-Process Plugin Fault Guard** ✅ — `plugin-safety-guard.mjs` intercepts uncaught exceptions and unhandled rejections, emitting `[dsh-plugin-fault]` attribution so one plugin cannot take down the whole Harness.
- **Safe Mode & Recovery** ✅ — Detects the startup failure cause and writes an isolated profile, then **actually boots Harness with it** (`--profile desktop-safe-mode` plus `dsh-desktop-safe.patch.yml`, which drops the product plugins that the normal patch layer mounts) so basic functionality stays available. Note: the shell does **not yet** show anything in the UI while safe mode is active — that indicator is a **deliberately deferred feature**, see [Planned](#planned-not-started).
- **Multi-Profile & Session Management** ✅ — Built-in Session and Profile managers for managing persistent configuration, environment variables, and metadata.
- **Structured Shell Logging** ✅ — `tauri-plugin-log` writes to `app_data_dir/desktop.log` (5 MB × 2 rotations, local timezone), kept separate from Harness-side `harness.log` / `app.log` so you can tell "shell problem" from "Harness problem".
- **Mobile Bridge** ✅ — LAN HTTP server with a pairing page (QR code + pairing token) forwarding RPC to Harness. It does **not** listen by default: you must start it explicitly from the application menu ("Phone Pairing (LAN)"). Access is constrained by the Harness `dsh-auth-*` cookie handshake plus a session token, both revoked on stop. The menu's `Phone` submenu shows live bridge state (off / listening / paired), and the Harness sidebar carries a matching **in-page status indicator** — note the app has **no system tray yet**.
  - The indicator is injected into the Harness page by the shell (see [Harness page injection](#harness-page-injection) below). It is **status-only and deliberately not clickable**: pairing and stopping live in the native `Phone` menu, and the shell does not open an IPC entry point to the Harness remote origin just to duplicate one menu item. Its label follows the connection state ("Phone not connected" / "Phone connected") and it stays hidden in the collapsed sidebar while nothing is paired.
- **Desktop Customization** ✅ — Desktop brand assets and UI behaviors applied through `patch-package` patches and `patch.yml` passed to `web --patch`. Patches are tiered as `functional` / `ui-behavior` / `brand` (see [`patches/LAYERS.md`](patches/LAYERS.md)); failures degrade by default and are recorded per-patch in `MANIFEST.json` → `patches[]`, while `--strict` restores full fail-fast behaviour.
- **Single Instance** ✅ — Second launches focus the existing window instead of duplicating processes.
- **Automatic Updates** ✅ — `tauri-plugin-updater` is registered and the whole check → download → restart-to-install path is wired, including the in-app update page (`frontend/updates.html`, opened from the application menu's "Check for Updates"). Releases are read from **this** repository (`wang-yi-bit64/dsh-desktop`) and signed with **this project's own** minisign key. Read [Auto-update and the signing key](#auto-update-and-the-signing-key) before shipping a release.
- **Plugin Recovery Flow** ✅ — A real recovery page (`frontend/plugin-recovery.html`) reached from the error page whenever a plugin fault is suspected. It calls `recovery_status` (attribution verdict + suspected plugin list, straight out of `dsh_host::diagnostics`) and `recovery_action` (`safe-mode` / `restart` / `show-log` / `quit`), reports failures visibly, and follows `harness://status` so the restart is actually observable. It offers **non-destructive actions only** — see the archived item below for why "uninstall plugin" is deliberately absent.
- **Redacted Diagnostics Export** ✅ — One click produces `app_data_dir/exports/diagnostics-<timestamp>.zip` containing the three log files, the attribution verdict, an environment snapshot and `MANIFEST.json`. Every text entry is passed through five redaction rules (launch token, `dsh-auth-*` cookies, user-name path segments, API-key shapes, proxy credentials) and each rule's hit count is written into the bundle, so "was it redacted?" is a checkable fact rather than a promise. Available from the error page, the logs page and the application menu.
- **In-App Log Viewer** ✅ — `frontend/logs.html` reads the tail of `harness.log` / `desktop.log` / `app.log` (via `logs_read`), shows the file size, explicitly flags when it is only showing the tail, and links to the diagnostics export and the log folder.

### Archived (was implemented, now deleted — do not claim as usable)

- **Tier 0/1/2 Plugin Process Isolation 2.0** 🗄️ **archived (2026-09-10)** — The tiered sandbox host (`plugin-worker-host.mjs`), its JSON-RPC 2.0 transport and the circuit breaker (`plugin_worker.rs`) existed and were unit-tested, but **nothing ever called them**: the Node-side `PluginWorkerClient` had no consumer and the Rust side returned an identifiable `ISOLATION_NOT_WIRED` error rather than forging success. It was also **not on the plugin-mount path at all** (real mounting happens inside the Harness process, in the official Cordis system). It has now been deleted rather than kept: a module that is neither compiled, tested, nor capable of reaching the loader it claims to guard will silently rot. **The only plugin protection actually in effect is the in-process guard listed above** — a crash inside that process can still take Harness down, and this repository must not claim otherwise. Design document archived at [`docs/archive/plugin_isolation_architecture.md`](docs/archive/plugin_isolation_architecture.md).
- **Multi-Model Tool Gateway 2.0 (`dsh-model-gateway`)** 🗄️ **archived (2026-09-10)** — Schema validation, `anyOf`/`oneOf` sanitization, and multi-provider (OpenAI/DeepSeek/Gemini/Claude) dialect adaptation were implemented and tested, with no runtime consumer. The crate has been **removed from the workspace** (directory + members + `[workspace.dependencies]`) and its design document archived at [`docs/archive/model_gateway_design.md`](docs/archive/model_gateway_design.md), which still states the criteria for reviving it.
- **Plugin uninstall / disable** 🕓 **planned, deliberately not built** — The recovery page used to lead with an "uninstall plugin" button. It is **not implemented, and not by oversight**: uninstalling is destructive and irreversible, and the obvious "reversible" substitute (renaming the directory to `<name>.disabled`) was verified to be **not reversible at all** — market-installed plugins are described solely by `profiles/.generations/desired.json`, which the cold-start projector replays, so a manual rename is silently undone; removing the entry from that file instead makes `sweepRegistry()` delete the generation directory outright. With only "pretends to be off" and "really deletes" available, the shell offers neither. Full evidence chain in [`docs/dev-plan-disconnected-points.md`](docs/dev-plan-disconnected-points.md) (batch C).

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
  dsh-contracts/        # Pure Rust universal contracts (constants, error-code table E1xxx~E7xxx, IPC envelope, JSON-RPC, lifecycle)
  dsh-host/             # Headless core host library (process management, supervisor, crash diagnostics, log ring buffer, redacted diagnostics export, log tail reader)
  dsh-host-cli/         # Command-line interface for dsh-host (start / status / stop / tail / doctor)
src-tauri/
  frontend/             # Shell web pages (splash, error attribution, plugin recovery, updates, logs)
  resources/            # Assembled Harness runtime + brand assets (gitignored, generated by build scripts)
  src/                  # Tauri desktop layer (window management, application menu, IPC commands, Safe Mode, LAN mobile bridge, shell logging, updates)
    commands.rs             # The whole IPC surface: 17 commands, all returning IpcEnvelope<T>
    logging.rs              # Shell structured logging (desktop.log, 5 MB x 2 rotations)
    mobile_bridge.rs        # LAN mobile bridge (pairing page + dsh-auth-* cookie handshake + RPC forwarding)
build/                  # Runtime injection and guard scripts
  harness-node-entry.mjs    # Node entry adapter (also the cold-start projection and fault-attribution wiring point)
  plugin-safety-guard.mjs   # Global unhandled exception / promise rejection guard — formatFaultDetails is the ONLY plugin protection in effect (in-process)
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
  dev-plan-disconnected-points.md   # CURRENT MAIN PLAN: disconnected-point inventory (D1~D11) + batch A~G execution log
  dsh-desktop-redesign-architecture-and-plan.md  # Comprehensive redesign architecture & execution plan
  system_design.md                  # Core system design & invariant specifications
  archive/                          # ARCHIVED designs — dropped on purpose, code deleted, kept only for traceability
    model_gateway_design.md           # Model gateway (archived 2026-09-10; still lists revival criteria)
    plugin_isolation_architecture.md  # Plugin isolation sandbox (archived 2026-09-10)
  dsh-upgrade-checklist.md          # DSH upstream upgrade checklist (patch regeneration -> gates -> 3-platform smoke)
  harness-packaging-and-compatibility.md  # Long-term plan for artifact slimming and patch fragility governance
```

## Architecture & Roadmap

The left column is the **design scope**; the right column is **whether it is currently on the runtime path**. The two are not interchangeable (see [`AGENTS.md` §7](AGENTS.md#7-宣称纪律claim-discipline)).

| Phase | Designed scope | Current status |
|-------|---------------|----------------|
| P0 | Contracts crate (`dsh-contracts`), error taxonomies, orphan process protection (Win32 Job Objects / POSIX process groups), headless core crates (`dsh-host`, `dsh-host-cli`) | ✅ wired |
| P1 | Supervisor state machine and self-healing, ring-buffer log persistence, crash attribution analysis, Safe Mode recovery profiles | ✅ wired |
| P2 | Decoupled worker/subprocess sandbox host (`plugin-worker-host.mjs`), JSON-RPC 2.0 transport, error trip-wires, circuit breaker (`plugin_worker.rs`) | 🗄️ **archived (2026-09-10)** — never had a runtime caller, and was not on the plugin-mount path at all; deleted rather than left rotting. In-process fault attribution is all that remains |
| P3 | Multi-provider schema sanitization, complex union normalization (`anyOf`/`oneOf`), payload adaptation (`dsh-model-gateway`), microsecond benchmarks | 🗄️ **archived (2026-09-10)** — removed from the workspace entirely; the archived design doc keeps the revival criteria |
| P4 | Unified `IpcEnvelope<T>` responses in Tauri commands; one-click redacted diagnostic exports (`diagnostics.zip`); in-app log viewer | ✅ **wired** — all 17 commands return `IpcEnvelope<T>`; redacted export (5 rules, `app_data_dir/exports/`); `frontend/logs.html` |

### Planned (not started)

- **Safe Mode in-app indicator** 🕓 **deferred on purpose** — when safe mode is active the shell currently gives the user **no visible sign** of it. Upstream solves this by injecting a banner into the Harness page (with "Remove plugins" / "Exit Safe Mode" actions). The capability is not missing by accident: it is deliberately postponed until the rest of the shell is stable, so that the injection mechanism is built once, on settled foundations, rather than retrofitted. Safe mode itself works correctly today (see "Wired capabilities") — only its visibility is pending.
- **Plugin uninstall / disable** 🕓 **deferred on purpose** — see the planned note in "Features" above. This waits on an upstream *disable* semantic rather than on shell work: today the only two available behaviours are "silently reverted on next cold start" and "irreversibly deleted".

## Testing

The headless gate runs without a display and without the 300 MB assembled runtime (INV-6):

```sh
cargo test -p dsh-contracts -p dsh-host -p dsh-host-cli
```

Integration tests spawn a real Node process running `scripts/mock-harness.mjs`, so they need a Node.js binary on `PATH` (override with `DSH_TEST_NODE`) and skip themselves cleanly when none is found. Failure modes — startup failure, missing URL, port-in-use retry, post-ready crash — are injected through `mock-harness.mjs` argv and environment variables rather than mocked in Rust. `scripts/fault-inject.mjs` additionally verifies orphan-process cleanup and exit-code attribution against `dsh-host-cli`.

### Verification gates

Some of the claims in this file cannot be checked by the compiler, because the thing being checked straddles a language boundary or is a property of the shipped files rather than of a function. Each of those claims has a gate:

| Command | What it actually protects |
|---------|---------------------------|
| `npm run verify:ipc-surface` | Command definitions ↔ `generate_handler!` registration ↔ page `invoke`/`listen` ↔ `local_page` targets ↔ `#[allow(dead_code)]` registrations. `src-tauri` is an rlib, so `dead_code` never fires for a `pub` command nobody calls — this is the only thing that catches "written but never wired". |
| `npm run verify:shell-pages` | Every shell page's inline script is executed in a DOM shim and **every button is clicked**. Catches `getElementById` returning `null` (which aborts the rest of the script and silently kills *every* listener on that page) and buttons left in the HTML with no listener attached. |
| `npm run verify:harness-inject` | The Harness-page injection script's DOM behaviour, including a **falsifiability check**: the script is reverted to upstream's behaviour and the assertions are required to go red. |
| `npm run verify:patches` | `patches/` and the tier manifest in `scripts/patch-layers.mjs` agree, and every patch filename yields a derivable package name. |
| `npm run verify:prune` / `npm run verify:variants` | The two prune rules that shape the shipped `node_modules` tree: which dev-artifact directories are safe to delete (content, not name — `yaml/dist/doc` is a runtime path), and which foreign-platform native variants must go before linuxdeploy scans the AppDir. Both carry a falsifiability check against the previous rule. |
| `npm run verify:version` | The version is identical in `package.json` (single source of truth), `tauri.conf.json` (inherits it), and `Cargo.toml` (synced by script); on a tag build it additionally checks **the tag matches the version**. A mismatch makes the installer claim a different version, and the updater's version comparison decides whether to offer an update based on it — one mistake affects every installed user. |
| `npm run verify:commits` / `npm run verify:changelog` | Self-tests for the changelog generator and its commit parser. A generator that breaks and **silently emits an empty changelog** is worse than no generator: the release page would read "nothing changed". |
| `npm run verify:target` | The build host and the packaging target are the same platform/arch — checked before 300 MB of runtime gets assembled into the bundle. |
| `npm run verify:release-workflow` | The release workflow's own two silent failure modes: `tauri-action` inserts its own `build` and `--` (so `tauriScript` must not carry either), and shell variables must be `${braced}` when followed by non-ASCII punctuation (macOS bash 3.2 otherwise swallows it into the variable name). Both turned the first `v0.1.0` release fully red while every local gate stayed green. |
| `npm run fault-inject` | Orphan-process cleanup and exit-code attribution against a real `dsh-host-cli` binary (10 assertions). |
| `npm run smoke:headless` / `npm run smoke` | Layered smoke: L1 headless (spawn → ready → serving → clean exit, no orphans) and L2 GUI launch. |

`verify:shell-pages` does not replace looking at the pages: it does not render, lay out, or run CSS. It answers one narrow question — after a page's script finishes loading, is every listener actually attached.

## Notes

- `node_modules/`, `harness-deps/`, `src-tauri/target/`, and `src-tauri/resources/` are gitignored; `resources/` is generated by the build script to avoid repository bloat.
- On fresh checkouts without bundled resources, run `node scripts/stub-tauri-resources.mjs` before running `cargo check` or `cargo test` to generate dummy resources for Tauri's compile-time validation.
- **Updater endpoint & signing key** — the updater reads releases from **this** repository and verifies them against **this project's own** minisign public key. The operational details (where the private key lives, how CI receives it, what breaks if it is lost) are in [Auto-update and the signing key](#auto-update-and-the-signing-key).

## Auto-update and the signing key

The updater endpoint is `https://github.com/wang-yi-bit64/dsh-desktop/releases/latest/download/latest.json`, and `tauri.conf.json` → `bundle.createUpdaterArtifacts` is `true`, so `npm run build` emits the signed artifacts **and** the `latest.json` manifest that this endpoint serves.

> `latest.json` has to be among the release assets — **without it, auto-update is broken**. The release workflow (below) has `tauri-action`'s `uploadUpdaterJson` produce and upload it; if you build with `npm run build` and upload manually, do not forget this file.

Update integrity rests on a single minisign key pair:

| Item | Where it is |
|------|-------------|
| Public key | `src-tauri/tauri.conf.json` → `plugins.updater.pubkey` (safe to commit — it only verifies) |
| Private key | `~/.tauri/dsh-desktop.key` — **never commit**, never copy into the repository |
| Offline backup | `~/.tauri/backup/dsh-desktop.key.<timestamp>`, with the matching `.pub` beside it |
| CI access | GitHub Actions secret `TAURI_SIGNING_PRIVATE_KEY` on `wang-yi-bit64/dsh-desktop`, used **without a password** |

A build without signing credentials still produces a bundle, but such a bundle cannot be installed by an already-released client — the signature check rejects it. CI therefore verifies the secret exists *before* starting the expensive build and fails early with an explicit `::error::` when it is missing, rather than discovering the problem at the end.

**Losing the private key is unrecoverable for existing users.** The public key is compiled into every shipped binary; a new key pair means a new public key, and installed clients will keep rejecting updates signed by it. Treat `~/.tauri/dsh-desktop.key` as release-critical infrastructure rather than as a local developer file.

## Versioning & Release

**The single source of truth for the version is `package.json` → `version`.** `src-tauri/tauri.conf.json` writes `"../package.json"` and inherits it natively (the Tauri schema explicitly allows a path to a `package.json`), so it stores no second copy; `Cargo.toml`'s workspace version is synced by script because Cargo cannot read `package.json`.

The bump rule follows [Conventional Commits](https://www.conventionalcommits.org/) and is **executable** rather than a convention people are asked to remember:

| Commits since the last tag | Bump | Example |
|---------------------------|------|---------|
| Any breaking change (`!` or a `BREAKING CHANGE:` footer) | `major` | 0.3.1 → 1.0.0 |
| Any `feat` | `minor` | 0.1.0 → 0.2.0 |
| Any `fix` / `perf` | `patch` | 0.2.0 → 0.2.1 |
| Only `docs` / `chore` / `ci` … | **no release** | Nothing in the shipped product changed |

```bash
npm run version:show                        # current version, latest tag, suggested bump
npm run version:bump -- auto --dry-run      # preview only, writes nothing
npm run version:bump -- auto --commit --tag # bump + regenerate CHANGELOG + commit + local tag
git push origin main --follow-tags          # pushing the tag triggers the release
```

`--commit` also **regenerates the matching `CHANGELOG.md` section inside the same commit** — the version and the changelog belong to one release, and splitting them across two commits all but guarantees a tag pointing at the commit that has the version but not the changelog, leaving `CHANGELOG.md` permanently one version behind. `--tag` creates a **local** tag only; whether to push it is a human decision.

**The changelog is derived from git history** (`npm run changelog:write` / `changelog:notes`). The in-repo `CHANGELOG.md` and the GitHub Release body come from the same data and the same rendering code, so they cannot contradict each other. Two hard rules: an unrecognised commit type (such as the historical `debug(ci):`) lands in "Other" rather than being **silently dropped** (dropping makes the changelog lie by omission), and breaking changes appear **both** in the pinned section and under their own type.

> Why not GitHub's built-in `--generate-notes`: it summarises **merged PRs**, and this repository pushes straight to `main` (`gh pr list --state all` is empty). Measured output was a single line, `**Full Changelog**: …`, with zero entries.

### Release workflow

| Workflow | Trigger | What it does |
|----------|---------|--------------|
| [`.github/workflows/ci.yml`](.github/workflows/ci.yml) | push to `main` / any PR / manual | Three-platform `test` (static gates + clippy + unit tests) → `smoke-headless` (L1 + fault injection) → on `main`, additionally `build` (assemble real resources + bundle + L2 + size report) |
| [`.github/workflows/release.yml`](.github/workflows/release.yml) | **push a `v*` tag** / manual with a tag | `preflight` (version↔tag consistency + second-scale static gates) → three platforms build in parallel, **create/update the GitHub Release** and upload installers, `.sig` signatures and `latest.json` |

- **Tags trigger releases, not `main` commits**: a release is a one-shot, irreversible act. A tag is an explicit, single declaration of intent; auto-releasing every commit would turn "publishing" into a background action requiring no decision. The manual trigger exists to **re-run the same tag** after a failure, since deleting an already-published tag is destructive.
- **Bundle types are declared explicitly per platform**: `nsis` on Windows, `app,dmg` on macOS, `deb,appimage` on Linux. This deliberately does not rely on `bundle.targets` in `tauri.conf.json`, which lists only the Windows-only `nsis`.
- **Boundary with CI**: the release workflow does **not** re-run the full Rust test matrix — that is CI's job for the same commit. `preflight` runs only second-scale gates so it can fail before assembling 300 MB of runtime. **Only tag commits that are green on `main`**; that is a deliberate, accepted boundary.

## Harness page injection

The shell injects a small script into every Harness page load through Tauri's `initialization_script` — the equivalent of an Electron `preload` script. It runs before the document is parsed, on every top-level navigation, and it self-guards by origin, so the shell's own local pages (`index.html`, `error.html`, `updates.html`, …) and sub-frames are untouched.

Two consequences deserve to be stated explicitly, because an earlier version of this document got them wrong:

1. **`window.*` globals *can* be defined on the Harness page.** This document used to claim the opposite ("a Tauri webview has no preload or initialization script"). That was a wrong mechanism claim. The directory-picker rule it was used to justify still stands, but for reasons that are actually true — see the picker section above.
2. **The channel is one-way: shell → page.** State is pushed with `webview.eval()`, so **no** IPC command is exposed to the Harness remote origin. Anything that would need the reverse direction is deliberately not built.

Current consumer: the phone status indicator (`src-tauri/frontend/harness-ui-inject.js`, pushed by `src-tauri/src/harness_ui.rs`). Its DOM-side behaviour is covered by a headless self-test built on a minimal DOM shim:

```sh
npm run verify:harness-inject
```

That suite also carries a **falsifiability check**: it reverts the script to upstream's behaviour — which leaks the indicator into the sidebar in an unrendered state — and requires the assertions to go red. If they don't, the gate fails. A test that cannot fail is decoration, not a defence.

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
- **The `prepare:harness` idempotency fast path validates the full bundle manifest.** It previously checked only three files, so a `resources/` tree missing `bin/` or `plugin-safety-guard.mjs` was accepted as complete and the build was skipped. `plugin-safety-guard.mjs` is imported directly by `harness-node-entry.mjs`, so a package missing it cannot start Harness at all; a missing `bin/` also makes `cargo build` fail on the `resources/bin/*` glob. The completeness check now mirrors `tauri.conf.json` → `bundle.resources`.
- **`shell == None` still goes through `harness_env`.** `Launcher::execute` previously handed the raw `capture_shell_environment()` result to the child, so contract variables such as `DSH_HOME` were never injected. Harness then fell back to `~/.dsh`, writing mutable state outside `app_data_dir` (an INV-1 violation). The GUI and CLI paths now both inject the contract environment.

Separately, the workspace directory picker must go through the Host seam and never a renderer global bridge. This used to be justified by "a Tauri webview has no preload or initialization script, so no `window.*` global can exist" — **that mechanism claim was wrong** (Tauri's `initialization_script` is the preload equivalent, and this repository now uses it to inject the phone status indicator). The rule still holds, for reasons that are true: a `patch-package` patch once rewrote the native picker to call `window.dshDesktopDirectoryPicker.pick()`, a global that **nothing ever defined**, so importing a project always failed with "无法打开文件夹 / DSH Desktop directory picker bridge is unavailable". And even with injection available, routing the picker through the page would require opening an IPC entry point for the Harness **remote origin**; injection is deliberately used only for the one-way **shell → page** direction. The patch is gone and the stock path is restored: the client calls `ctx.uiWorkspace.pickDirectory()` → the Host `ctx.directoryPicker` seam → the Win32 `IFileOpenDialog` opened inside the Harness process. `assertPickerSurfaceIsHostBacked()` in `scripts/prepare-harness.mjs` verifies this after patches apply and fails the build otherwise.

To build a real installer, `npm run tauri build` downloads the NSIS toolchain on first use; on networks that cannot reach GitHub releases the bundling step fails with `timeout: global` even though the `.exe` and resources have already been produced successfully.

## Security Notes

- **Dependabot / RUSTSEC-2024-0429 (GHSA-wrw7-89jp-8q8g)** — `glib 0.18.5` is flagged for an unsoundness in `glib::VariantStrIter`. It is a **Linux-only, transitive** dependency pulled in by Tauri's GTK3 backend, and our codebase never invokes the affected API. The fix will be automatically resolved once upstream Tauri migrates to gtk-rs 0.20+.
- **Diagnostics bundles are redacted before they are written, not after.** The export path exists for the "please send me your logs" workflow, and users composing that message by hand will not strip credentials first — `harness.log` contains the launch token and `dsh-auth-*` cookies in plain text. Every text entry therefore passes through five redaction rules (launch token, `dsh-auth-*` cookies, user-name path segments, API-key shapes, proxy credentials) **before** being written into the archive, and each rule's hit count is recorded in the bundle's `README.txt` and in the command's return value, so "was anything actually redacted?" is a checkable fact rather than a promise. The rules have both positive cases (the original value must not survive) and negative cases (version numbers, ports, `E`-codes and package names must **not** be mangled — a bundle with its version numbers blanked out has no diagnostic value). Nothing is uploaded anywhere; the archive stays on disk until the user chooses to send it.
