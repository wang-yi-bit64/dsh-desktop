# 本地工具链已知环境限制

> 从 `AGENTS.md` §2 迁入，原样保留（GNU 工具链下的两条限制，不是代码问题）。

#### ⚠️ 已知环境限制：GNU 工具链下 Clippy 在旧 `dsh-model-gateway` 上 ICE（该 crate 已归档，条目仅留档）

同一台 `x86_64-pc-windows-gnu` 宿主机上，`cargo clippy --workspace` 曾在编译
`dsh-model-gateway` 时**编译器内部错误**（`the compiler unexpectedly panicked`，
rustc 1.97.1 / clippy 0.1.97），停在 `codegen_and_build_linker`。

- **性质**：clippy 自身缺陷（环境相关），与本仓库源码无关：同一命令在 `cargo check --workspace` 下完全通过。
- **现状（2026-09-11 已实测复核）**：该 crate 于 2026-09-10 随批次 F 从 workspace 移除后，
  **本机 `cargo clippy --workspace --all-targets -- -D warnings` 已可正常执行**（本地实跑 exit 0，
  增量构建约 6 秒）。也就是说：**现在本地就能复现 CI 的 clippy 失败，不必等 CI 报错再回头改。**
  这一点在 2026-09-11 修 `clippy::result_large_err` 时起了决定作用——先本地复现、再修、再本地验证通过，
  一轮闭环，没有消耗三平台 CI 跑一轮十几分钟的反馈时间。
  ⚠️ **仍不要把 clippy 当成「本地有没有都无所谓」**：触发该 ICE 的是一类「某个 crate 恰好触到
  clippy 代码生成路径」的环境问题，将来任何新 crate 都可能复现。因此：
  1. 本地首选 `cargo clippy --workspace --all-targets -- -D warnings`（与 CI 逐字一致）；
     若某天又 ICE，退回 `cargo check --workspace --all-targets`（能报出全部真实 warning，包括
     CI `-D warnings` 会拦下的 `unused_imports`）；
  2. clippy 的最终权威执行者仍是 CI（MSVC 工具链，三个平台都跑）——本地通过不等于三平台都通过。

#### ⚠️ 已知环境限制：GNU 工具链下 `dsh-desktop` 的测试二进制无法加载

在 **`x86_64-pc-windows-gnu`**（mingw）宿主机上，`cargo test -p dsh-desktop` 会失败：

```text
dsh_desktop_lib-<hash>.exe: error while loading shared libraries:
api-ms-win-core-winrt-error-l1-1-0.dll: cannot open shared object file
（或 STATUS_ENTRYPOINT_NOT_FOUND / 0xc0000139）
```

- **根因**：该导入来自 Tauri 无条件链接的 `webview2-com-sys`（WinRT）。本机 `System32` 与 `System32\downlevel` 下都没有该 API set DLL，GNU 运行时加载器不会去 MSVC 的解析路径找它。
- **性质**：失败发生在**动态加载阶段**，早于测试 harness 的 `main()`——因此与任何测试代码无关，也不会因源码改动而出现或消失。
- **后果**：`cargo test --workspace` 在本机必然失败；`src-tauri` 下的单元测试（含 `mobile_bridge.rs`）**只能编译、不能本地执行**。
- **怎么办**：
  1. 本地依赖上面第 1 条的**无头门禁**（不含 `src-tauri`，这正是 INV-6 的价值）；
  2. `src-tauri` 的行为由第 7 条的 L1/L2 烟雾覆盖（它派生真实进程，不依赖 Rust 单测）；
  3. `src-tauri` 单测的实际执行者是 CI——GitHub runner 用 **MSVC** 工具链，该导入可正常解析，故 CI 的 `cargo test --workspace` 有意义。
  4. 若本机需要跑这些单测，唯一可靠路径是切到 MSVC 工具链（`rustup default stable-x86_64-pc-windows-msvc`），这不是代码问题。

