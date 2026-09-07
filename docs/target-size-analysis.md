# `target/debug/deps` 体积分析报告

> 项目：`D:\work-code\dsh-desktop`
> 测量时间：2026-09-07 13:45
> 结论：可安全回收 **约 12 GB**，占当前 13.9 GB 构建产物的 86%

---

## 1. 实测数据（不是估算）

| 路径 | 体积 | 状态 |
|------|------|------|
| `target/` | **8.2 GiB** | 活跃（最后写入 09-07 10:02） |
| ├─ `target/debug/deps` | 4.8 GiB | 本次问题主体 |
| ├─ `target/debug/build` | 1.7 GiB | 构建脚本输出（含 Tauri 插件的 Node 侧产物） |
| ├─ `target/debug/incremental` | 1.4 GiB | 增量编译缓存 |
| └─ `target/debug/resources` | 0.38 GiB | 打包进应用的 harness/node 运行时 |
| `src-tauri/target/` | **5.7 GiB** | **孤儿产物（最后写入 09-03 18:48）** |
| ├─ `src-tauri/target/debug/deps` | 3.6 GiB | 完全不再被写入 |
| ├─ `src-tauri/target/debug/build` | 0.83 GiB | 同上 |
| ├─ `src-tauri/target/debug/incremental` | 0.55 GiB | 同上 |
| └─ `src-tauri/target/debug/resources` + `dsh-desktop.exe` | 0.71 GiB | 同上 |
| **合计** | **13.9 GiB** | |

### 关于"10G"的口径差异

实测 `target/debug/deps` 为 **4.76 GiB（约 5.1 GB 十进制）**，并非 10 GB。你看到的 10 GB 来自以下叠加：

1. **两个 deps 目录被一起算**：`4.8 + 3.6 = 8.4 GiB ≈ 9.0 GB`（十进制）
2. **资源管理器按"分配大小"统计**：海量小文件（2438 个）产生簇碎片开销，显示值高于实际字节和
3. 若统计范围包含 `build` + `incremental`，则接近 10 GB

---

## 2. `deps` 目录的作用

`target/debug/deps` 是 Cargo 存放**所有编译单元产物**的地方，不是缓存，删除后重编即可再生：

| 类型 | 数量 | 体积 | 说明 |
|------|------|------|------|
| `.rlib` | 528 | 1.52 GiB | Rust 静态库（每个依赖 crate 一份） |
| `.rmeta` | 871 | 0.93 GiB | 元数据（供下游 crate 类型检查用） |
| `.exe` | 18 | 1.75 GiB | 主程序 + **4 个集成测试二进制**（每个都完整链接 tauri+tokio） |
| `.dll` | 43 | 0.55 GiB | 过程宏（如 `tauri_macros` 每份 73 MB） |
| `.d` | 936 | 0.01 GiB | Makefile 格式的依赖清单（文本文件） |

文件名格式 `<crate>-<hash>.ext`，其中 hash 由 **编译参数 + 依赖版本 + features** 决定。参数一变就产生新 hash，**旧文件不会被自动删除**。

---

## 3. 体积膨胀的四个根因（按贡献排序）

### 根因 1：孤儿目录 `src-tauri/target` —— 5.7 GB（41%）

`Cargo.toml` 中 workspace 声明了 `members = ["src-tauri", ...]`，此后 Cargo 统一使用**仓库根**的 `target/`。而 `src-tauri/target` 是 workspace 化之前在 `src-tauri/` 目录内直接执行 `cargo build` 留下的，自 09-03 起再无任何命令写入它。

**这是纯粹的死重量，删除零影响。**

### 根因 2：陈旧 hash 副本 —— 2.43 GiB（占 deps 的 51%）

对 `target/debug/deps` 按"包名 + 类型"分组后发现：

- 存在 **1467 个**同名同类型但 hash 不同的旧副本，共 **2.43 GiB**
- 典型：`windows_sys` 有 14 份 `.rmeta`（共 180 MB）、`dsh_host` 有 19 份 `.d`
- 成因：每次切换 feature 组合、改 `Cargo.toml`、升级依赖、切换 rustc 版本都会生成新 hash

Cargo **从不自动回收**这些旧副本。

### 根因 3：debug profile 未做瘦身 —— 结构性放大

`Cargo.toml` 只定义了 `[profile.release]`，**没有 `[profile.dev]`**，因此使用默认值 `debug = 2`（完整调试信息）。全部 557 个依赖 crate 都带完整 DWARF/PDB 调试信息。

证据：
- `libdsh_desktop_lib-*.rlib` 单份 148 MB
- `dsh_desktop-*.exe` 主程序 320 MB
- 单个集成测试二进制 `args_forwarding` 达 52.9 MB、`cli_blackbox` 达 52.3 MB

**这是每构建一次就再放大一次的因素，也是治本的关键。**

### 根因 4：依赖树规模 + Windows 巨兽 crate

`Cargo.lock` 共 **557 个包**。其中 Windows 绑定是空间大户：

| crate | 体积（含所有副本） |
|-------|------------------|
| `dsh_desktop_lib` | 816.6 MB |
| `dsh_desktop` | 419.1 MB |
| `windows_sys` | 290.9 MB |
| `dsh_host_cli` | 281.0 MB |
| `windows` | 257.2 MB |
| `tauri_utils` | 207.4 MB |
| `tauri_macros` | 191.5 MB |
| `tokio` | 100.7 MB |

`windows` / `windows-sys` 0.61 因 feature 展开产生海量内联包装函数，是 Rust 生态著名的体积放大器。

---

## 4. 清理方案（按风险从低到高）

### S0 · 删除孤儿目录 —— 立即回收 5.7 GB，零风险 ★推荐

`.gitignore` 已忽略 `src-tauri/target/`，目录内含 `CACHEDIR.TAG`，且 4 天无写入。

```powershell
# PowerShell（先看一眼确认）
Get-ChildItem 'D:\work-code\dsh-desktop\src-tauri\target' -Recurse -File |
  Measure-Object -Property Length -Sum |
  Select-Object Count, @{n='GB';e={[math]::Round($_.Sum/1GB,2)}}

# 确认无误后删除
Remove-Item -LiteralPath 'D:\work-code\dsh-desktop\src-tauri\target' -Recurse -Force
```

```bash
# Git Bash 等价命令
du -sh src-tauri/target && rm -rf src-tauri/target
```

### S1 · 清理 incremental 缓存 —— 再回收 1.4 GB

`target/debug/incremental` 删除后 Cargo 会自动重建，仅影响下一次增量编译速度。

```powershell
Remove-Item -LiteralPath 'D:\work-code\dsh-desktop\target\debug\incremental' -Recurse -Force
```

### S2 · 回收陈旧 hash 副本 —— 约 2.4 GB

**方式 A（推荐，精准）**：安装 `cargo-sweep`，只删"N 天未被访问"的产物，保留当前有效构建：

```bash
cargo install cargo-sweep
cd D:\work-code\dsh-desktop
cargo sweep -r --time 7 .     # 清理 7 天前的旧产物
```

> Windows 上若 NTFS 未启用 `atime`，cargo-sweep 会退化为按 mtime 判断，可能误伤。首次使用建议先用 `--dry-run` 查看将被删除的文件。

**方式 B（简单粗暴）**：直接清空活跃 target，代价是**全量重编**（本项目 557 依赖 + Tauri，约 10–20 分钟）：

```bash
cargo clean          # 只清 target/
```

### S3 · 治本：给 dev profile 瘦身 —— 后续每次构建都变小 ★强烈推荐

在根 `Cargo.toml` 的 `[profile.release]` **之前/之后**追加（二者不冲突）：

```toml
[profile.dev]
# 只保留行号表，够用于断点与 panic 回溯，但砍掉绝大部分 DWARF
debug = "line-tables-only"

[profile.dev.package."*"]
# 第三方依赖完全不带调试信息 —— 这是收益最大的一项
debug = false

[profile.test]
debug = "line-tables-only"

[profile.test.package."*"]
debug = false
```

**预期效果**：`.rlib`（1.52 GiB）与 18 个 `.exe`（1.75 GiB）中绝大部分是调试信息，整体可下降 **50%–70%**。

> 注意：修改 profile 后需 `cargo clean` 才会作用于已存在的产物。

### S4 · 可选：关闭增量编译

在 `D:\work-code\dsh-desktop\.cargo\config.toml`（当前不存在，需新建）中：

```toml
[build]
incremental = false        # 或设环境变量 CARGO_INCREMENTAL=0
```

省下 `incremental` 目录的空间，代价是 debug 迭代编译略慢。

### S5 · 防止复发

1. **统一入口**：始终在**仓库根**执行 `cargo` / `cargo tauri` 命令，不要 `cd src-tauri` 后再构建
2. **配置上移**：把 `src-tauri/.cargo/config.toml` 里的 rsproxy 源替换配置上移到仓库根 `.cargo/config.toml`，让三个 crate 共享同一份配置（顺带避免目录级配置造成的行为差异）
3. **定期维护**：把 `cargo sweep -r --time 14 .` 加入月度维护清单
4. **CI/磁盘告警**：`target/` 超过 6 GB 时提醒清扫

---

## 5. 执行后的预期

| 阶段 | 操作 | 回收 | 剩余 |
|------|------|------|------|
| 当前 | — | — | 13.9 GB |
| S0 | 删孤儿 `src-tauri/target` | -5.7 GB | 8.2 GB |
| S1 | 删 `incremental` | -1.4 GB | 6.8 GB |
| S2 | `cargo sweep` 清陈旧副本 | -2.4 GB | 4.4 GB |
| S3 | profile 瘦身（需重编） | 再降 50–70% | **~1.5–2 GB** |

S0 + S1 是**零风险、立刻生效**的 7.1 GB，建议优先执行。

---

## 6. 安全性说明

- 两个 `target/` 目录均含 `CACHEDIR.TAG`，是 Cargo 官方标记的可再生缓存目录
- `.gitignore` 已忽略 `/target/` 与 `src-tauri/target/`，`git ls-files` 确认**无源文件被跟踪**
- 删除后唯一的代价是重新编译时间，**不会丢失任何源码或配置**
- 当前 D 盘剩余 122 GB（已用 51%），空间压力尚不紧急

### ⚠️ 执行 `cargo clean` 后的必做恢复步骤

本机是 **windows-gnu** 工具链，`dsh-desktop.exe` 依赖 `WebView2Loader.dll` 才能启动（缺失会报 `0xC0000135`）。
该 DLL 由 `webview2-com-sys` 的构建脚本生成在 `target/debug/build/webview2-com-sys-*/out/x64/` 下，
**每次 `cargo clean` 后必须重新复制到 `target/debug/` 与 `target/debug/deps/`**：

```bash
# clean 并重新 build 之后执行
cp target/debug/build/webview2-com-sys-*/out/x64/WebView2Loader.dll target/debug/
cp target/debug/build/webview2-com-sys-*/out/x64/WebView2Loader.dll target/debug/deps/
```

因此：**S0 + S1 可随时执行（不动活跃 target，无需恢复 DLL）；S2 的方式 B 与 S3 会触发重编，记得补 DLL。**
