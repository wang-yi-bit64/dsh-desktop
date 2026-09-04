# Spike 结论：Webview 兼容性（阶段 0 任务 0.2）

> **状态：待执行**（模板已就位，三平台逐项勾验后回填）。
> 这是全计划最大的外部不可控风险（R-1），Go/No-Go 依据。

## 方法

用最小 Tauri 壳（阶段 0 任务 0.1 骨架 + `on_navigation` 放行 127.0.0.1）加载
真实 harness UI：

```sh
# 1. 手工组装一次 harness 树
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci   # 在暂存目录
npx patch-package

# 2. 启动真实 harness（本机 node < 24 时用捆绑 node）
node --expose-internals <dsh>/lib/bin.js web \
  --patch build/dsh-desktop.patch.yml --no-open --host 127.0.0.1 --port 4173

# 3. cargo tauri dev 打开骨架窗口，加载 http://127.0.0.1:4173
```

## 兼容性清单

| 能力 | Win/WebView2 | mac/WKWebView | Linux/webkitgtk |
|---|---|---|---|
| 首屏渲染、主题 | ☐ | ☐ | ☐ |
| 会话流式输出（SSE/WS） | ☐ | ☐ | ☐ |
| 文件上传 / 下载 | ☐ | ☐ | ☐ |
| 剪贴板复制 | ☐ | ☐ | ☐ |
| 快捷键（含 macOS cmd 系列） | ☐ | ☐ | ☐ |
| 中文输入法（IME） | ☐ | ☐ | ☐ |
| `window.open` / `target=_blank` 外链行为 | ☐ | ☐ | ☐ |
| 下载文件落盘位置 | ☐ | ☐ | ☐ |
| 控制台报错清单 | ☐ | ☐ | ☐ |

## 附加结论（回填到 `crates/dsh-host/src/contracts.rs`）

- [ ] **C1：DSH 是否支持 `--port 0`**（支持则把 `PORT_ZERO_SUPPORTED` 置为
  `true`，端口 TOCTOU 彻底消除）
- [ ] **C4：本机就绪实测时长**（Windows / 其它，用于校准 120s / 45s）
- [ ] remote capability 是否支持通配端口 `http://127.0.0.1:*`
  （阶段 3 ADR-4 的输入，R-2）

## 退出标准

三平台核心会话链路可用 → **Go**。不可用项进入风险登记册并给出规避方案
（如下载改走宿主命令）；无法规避 → **No-Go**（评估 sidecar Electron/Blink 内核）。
