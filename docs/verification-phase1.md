# 阶段 1 验证记录：主链路与故障注入（任务 1.6）

> **状态：进行中**。自动化部分由 `scripts/fault-inject.mjs` 在 Windows 上执行；
> POSIX 场景（PDEATHSIG / 进程组）由 CI 与手工清单补齐。

## 1. 自动化验证（`cargo test --workspace`）

| 契约/不变量 | 覆盖 | 状态 |
|---|---|---|
| C1 argv 构造（web --patch --no-open --host --port） | `process::tests` | ✅ |
| C2 env 组装（DSH_HOME/NO_COLOR/FORCE_COLOR/缓存开关/PATH 合并） | `env::tests` | ✅ |
| C3 stdout token 行解析（含 ANSI 清洗、多匹配取首个） | `token::tests`、`logs::tests` | ✅ |
| C4 就绪判据（401 健康、500 不健康、稳定窗、超时、平台超时值） | `readiness::tests` | ✅ |
| C6 停止语义（SIGTERM→4s→SIGKILL；忽略 SIGTERM 被强杀） | `stop::tests`（mock node 子进程） | ✅ |
| C7 失败归因（DSH entry failed / uncaught / rejection / EADDRINUSE / stderr 末行 / 本次尝试切片） | `logs::tests`、`launch::tests` | ✅ |
| C8 布局（资源在 resource_dir、可写在 app_data_dir、exec bit 兜底） | `paths::tests` | ✅ |
| INV-1 资源只读 | `paths::tests::ensure_dirs_creates_only_writable_tree` | ✅ |
| INV-3 陈旧进程清扫（死记录清理、外部进程不误杀） | `process::tests::sweep_*` | ✅ |
| 端口策略（预留端口、PORT_ZERO 回填位） | `launch::tests` | ✅ |
| 日志滚动落盘（5MB×3） | `logs::tests::log_file_rotates_by_size` | ✅ |

## 2. 故障注入（`node scripts/fault-inject.mjs`，dsh-host-cli + mock-harness）

| 场景 | 预期 | Windows 实测 |
|---|---|---|
| A 正常退出 | 子进程被回收，无孤儿 | _待跑_ |
| B 强杀宿主进程（taskkill /T /F ≈ kill -9） | Job Object 内核兜底，无孤儿 | _待跑_ |
| C mock startup 失败 | 快速失败 + `DSH entry failed` 归因 | _待跑_ |
| D mock EADDRINUSE | 快速失败（远小于 120s），换端口重试 3 次 | _待跑_ |
| E mock after-ready（就绪 5s 后崩溃） | exit watcher 捕获 → 失败归因 | _待跑_ |
| F pidfile 清扫 | 死记录清理、外部 node 不误杀 | _待跑_ |

## 3. GUI 层手工清单（`cargo tauri dev`）

- [ ] mock 模式（`DSH_MOCK=1`）：splash → 800ms 后导航到 mock 页
- [ ] mock `--fail startup`：错误页显示归因，「重试」可恢复
- [ ] mock `--fail after-ready`：窗口自动回到错误页（exit watcher 生效）
- [ ] 真实模式：`npm run dev` → 完整 harness UI，控制台无 CSP 报错
- [ ] 安全验证：在 harness 页 devtools 执行
      `window.__TAURI__.core.invoke('harness_status')` → **必须被拒**
      （无 remote capability + 命令守卫）
- [ ] Cookie：重启 harness 3 次后 127.0.0.1 域 `dsh-auth-*` cookie ≤ 1
- [ ] 快速开关应用 5 次：pidfile 清扫正常，无累积残留
