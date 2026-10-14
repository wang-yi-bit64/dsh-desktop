# `recover` 演示：一条命令证明崩溃自愈（无 GUI）

> **S6-2 的一页式复现步骤**。判据原文：「一条命令完成三段流程；陌生人照文档能复现，不需要窗口系统。」
> 本文档就是那份"照文档能复现"的证据——复制粘贴即可，无需图形界面、无需手动造故障。

---

## 1. 这条命令是什么

`dsh-host-cli recover` 在**无窗口系统**的前提下跑完三段流程，并把每一步如实打印：

| 段 | 做什么 | 你该看到什么 |
|---|--------|-------------|
| ① 启动 | 派生 `mock-harness` 子进程 | `第 1 次尝试启动` |
| ② 注入崩溃 | 让它启动即失败（`--fail startup`） | `崩溃 #1（将重启=true）→ 退避 100ms` |
| ③ 自动恢复 | 指数退避重启，有界且递增 | `退避序列 = [100ms, 200ms, 400ms]` → `断路器开路` |

成功时**退出码 0**，且输出里必须同时出现 `退避严格增长 = true` 与 `断路器开路 = true`。

> **它为什么不是"演示脚本"而是回归守卫**：`dsh_host::Supervisor` 此前**全仓没有运行时调用方**
> （CLI 走一次性 `Launcher`；`src-tauri` 用的是另一个类型 `HarnessSupervisor`）。
> 本命令是该模块**第一个真实的消费者**，也是 `AGENTS.md` §7.2
> 「Supervisor 自愈与退避」这一行从「⚠️ 未接线」改回「✅ 已接线」的前提。
> 守卫见 `crates/dsh-host-cli/tests/recover_cmd.rs`（黑盒：真派生子进程、真看退出码）。

---

## 2. 前置条件

| 需要 | 检查命令 | 不满足时 |
|------|---------|---------|
| Rust 工具链 | `cargo --version` | 先装（本仓 MSRV 见 `Cargo.toml` 的 `rust-version`） |
| Node.js | `node --version` | 装任意 LTS |
| CLI 二进制 | `cargo build -p dsh-host-cli` | **必须先构建**——`recover` 跑的是 `target/debug/dsh-host-cli` |

不需要：GUI、窗口系统、真实 Harness、300MB 运行时、网络。

---

## 3. 三步复现

### 3.1 准备一个最小资源目录

`recover` 需要一个**只含 mock 入口**的资源目录（真实 Harness 没法按需崩溃）：

```bash
RES=$(mktemp -d)      # Linux/macOS
DATA=$(mktemp -d)
cp scripts/mock-harness.mjs "$RES/"
cp build/*.mjs "$RES/" 2>/dev/null   # 看门狗等共用模块；缺失不影响主流程
```

Windows PowerShell 等价写法：

```powershell
$RES = Join-Path $env:TEMP "dsh-recover-res"
$DATA = Join-Path $env:TEMP "dsh-recover-data"
New-Item -ItemType Directory -Force -Path $RES, $DATA | Out-Null
Copy-Item scripts\mock-harness.mjs $RES\
Copy-Item build\*.mjs $RES\ -ErrorAction SilentlyContinue
```

### 3.2 构建并运行

```bash
cargo build -p dsh-host-cli
./target/debug/dsh-host-cli recover \
  --resource "$RES" \
  --data "$DATA" \
  --mock \
  --observe-secs 30
echo "退出码 = $?"
```

### 3.3 期望输出（Windows 实测，2026-10-11）

```text
[cli] mock 模式 → 入口已替换为 ...\mock-harness.mjs
[cli] recover 演示开始：注入故障模式 = startup，观察窗口 30s
[cli] 预期：启动失败 → 退避 100ms → 200ms → 400ms（递增） → 断路器开路
[cli]第 1 次尝试启动
[cli] 崩溃 #1（将重启=true）→ 退避 100ms
[cli]第 2 次尝试启动
[cli] 崩溃 #2（将重启=true）→ 退避 200ms
[cli]第 3 次尝试启动
[cli] 崩溃 #3（将重启=true）→ 退避 400ms
[cli]第 4 次尝试启动
[cli] 断路器开路：累计崩溃 4 次（上限 max_restarts 允许 3 次重启），Supervisor 停止
[cli] —— 汇总 ——
[cli] 观测到 3 次崩溃，退避序列 = [100ms, 200ms, 400ms]
[cli] 退避严格增长 = true；断路器开路 = true；耗时 0.8s
[cli] ✅ 自愈链路成立：崩溃 → 退避递增 → 有界重启 → 断路器开路
```

整个过程**约 0.8 秒**。

---

## 4. 判据与反例

### ✅ 算通过

同时满足：

1. 退出码 `0`
2. 输出含 `退避严格增长 = true`
3. 输出含 `断路器开路 = true`
4. 输出含 `第 2 次尝试启动` 与 `第 3 次尝试启动`（证明真的重启了多次）

### ❌ 算失败（且必须失败）

| 现象 | 含义 |
|------|------|
| `退避严格增长 = false`，退出码 `1` | **退避被绕过**——这是真缺陷，不是配置问题 |
| `断路器开路 = false` | 无限重启，熔断失效 |
| 未观测到任何崩溃 | 故障注入没生效（检查 `--mock` 与资源目录） |

**可证伪性已实证**：把 `crates/dsh-host/src/supervisor.rs` 的 `next_backoff` 改成
「恒返回 `current`」（即绕过退避）后重跑，实测输出：

```text
[cli] 退避序列 = [100ms, 100ms, 100ms]
[cli] 退避严格增长 = false；断路器开路 = true；耗时 30.0s
[cli] ❌ 退避未增长（观测到 [100ms, 100ms, 100ms]）：自愈链路不可信，属缺陷
```

退出码 `1`。**该判据确实能抓住绕过退避的缺陷**，不是"永远绿"的装饰。

---

## 5. 排障

| 症状 | 原因 | 处理 |
|------|------|------|
| `recover 需要 --mock` | 忘了加 `--mock` | 加上；真实 Harness 无法按需崩溃 |
| `未找到 target/debug/dsh-host-cli` | 未构建 | `cargo build -p dsh-host-cli` |
| `未观测到任何崩溃` | 资源目录缺 `mock-harness.mjs` | 检查 3.1 的拷贝步骤 |
| 退出码 1 且退避不增长 | **疑似真缺陷** | 保留完整输出，见 `docs/incidents/` |

---

## 6. 相关

- 契约 C10（重启退避 / 稳定窗口 / 断路器）：`crates/dsh-contracts/src/constants.rs`
- 单元不变式测试：`crates/dsh-host/src/supervisor.rs` 的 `mod tests`
- 集成测试（脱子进程的退避增长）：`crates/dsh-host/tests/supervisor_backoff.rs`
- 黑盒守卫（本命令的退出码）：`crates/dsh-host-cli/tests/recover_cmd.rs`
- 宣称口径与销账条件：`AGENTS.md` §7.2「Supervisor 自愈与退避」行 +
  `scripts/verify-claims.mjs` 的 `UNWIRED_ALLOW`
