# DSH Desktop 插件隔离沙盒与治理架构规范 (Plugin Isolation Architecture)

> RFC 编号: RFC-20260907-PLUGIN-ISOLATION  
> 状态: Draft -> Approved (Phase 1)  
> 适用版本: dsh-desktop >= 0.2.0  

---

## 1. 背景与核心问题

在当前的 DSH Desktop 架构中，第三方插件（例如 Community Plugins、MCP Tools、Market Extensions）直接通过 `import()` 动态加载进 Node.js 主宿主进程（In-Process 模式）。

### 存在的核心风险：
1. **进程脆弱性（Fragility）**：任何插件内部的未捕获异常（`throw error`）、死循环、未处理 Promise Rejection 会直接导致主 Node 进程崩溃。
2. **注册表冲突（Registry Collision）**：多个插件同时注册同名工具（如 `tool "recall" already registered`）或同名路由时，Cordis/DSH 会在启动阶段抛出致命异常。
3. **启动延迟（Boot Latency）**：随安装插件数量增多，启动时同步加载与初始化所有插件导致 Splash 界面等待时间显著变长。
4. **内存与资源泄露**：第三方插件占用的内存无法在卸载或出错时完全回收。

---

## 2. 目标架构与隔离分层

为实现“**单插件故障不影响主应用运行，高危插件完全进程隔离**”的目标，DSH Desktop 引入两级插件架构：

```
┌─────────────────────────────────────────────────────────────────┐
│                      DSH Main Host (Node.js)                    │
│  ┌────────────────────────┐         ┌────────────────────────┐  │
│  │   Core In-Process      │         │   Plugin Safety Guard  │  │
│  │   (Session/Webserver)  │         │   (Proxy / Lazy Load)  │  │
│  └────────────────────────┘         └───────────┬────────────┘  │
└─────────────────────────────────────────────────┼───────────────┘
                                                  │ JSON-RPC 2.0 (IPC / stdio)
                                      ┌───────────▼────────────┐
                                      │   Plugin Worker Host   │
                                      │   (Out-of-Process)     │
                                      │  ┌──────────────────┐  │
                                      │  │ Community Plugin │  │
                                      │  └──────────────────┘  │
                                      │  ┌──────────────────┐  │
                                      │  │ MCP Tool Server  │  │
                                      │  └──────────────────┘  │
                                      └────────────────────────┘
```

### 分层定义：
1. **Tier 0: Core Built-ins (In-Process)**
   - 包含 `@deepseek-ai/dsh` 核心引擎、Session 会话管理、Webserver、基础 Auth。
   - 高度稳定，具备强类型保障。
2. **Tier 1: High-Risk / Community Plugins (Out-of-Process Sandbox)**
   - 来自 DSH 市场或外部加载的第三方插件、MCP 工具。
   - 在独立的 Node.js 子进程（Worker Host）中运行。
   - 无论其崩溃、报错或挂起，主进程均可通过超时断路器（Circuit Breaker）和隔离保护正常提供基础服务。

---

## 3. 通信契约：JSON-RPC 2.0 协议

主进程与 Plugin Worker Host 之间通过 `stdio`（标准输入输出）按行（Line-delimited JSON）进行 RPC 交互：

> **契约源说明（2026-09 协议债务收敛）**：Rust 侧消息模型的唯一定义点是
> `crates/dsh-contracts/src/rpc.rs`（`RpcId` / `RpcRequest` / `RpcResponse` /
> `RpcError` / `RpcMessage`，含 NDJSON 序列化助手与单元测试）；
> `dsh-host/src/transport.rs` 仅 re-export，禁止重复定义。Node 侧
> `build/plugin-worker-host.mjs` 按同一协议手写实现——错误码与字段语义必须
> 与契约保持一致，新增方法时两端同步更新。

**错误码对照表（两端共用）**：

| 错误码 | 语义 | Rust 构造器 | Node 侧场景 |
|---|---|---|---|
| `-32700` | Parse error（非法 JSON） | `RpcError::parse_error` | stdin 行解析失败 |
| `-32600` | Invalid Request | `RpcError::invalid_request` | 非法 `jsonrpc` 版本标记 |
| `-32601` | Method not found | `RpcError::method_not_found` | switch 未命中方法名 |
| `-32602` | Invalid params | `RpcError::invalid_params` | 参数缺失/类型不符 |
| `-32603` | Internal error | `RpcError::internal_error` | 执行期内部错误 |
| `-32000` | Server error（自定义区间） | `RpcError::server_error` | 未捕获异常 / 未处理 Promise 拒绝 |

语义约束：响应中 `result` 与 `error` 互斥；`id` 永远序列化（不可确定时为
`null`，见 `RpcResponse::error`）；Notification（无 `id`）不期望回复。

### 3.1 握手与初始化 (`initialize`)
* **Request**:
  ```json
  {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "pluginsDir": "/path/to/plugins",
      "environment": { "NODE_ENV": "production" }
    }
  }
  ```
* **Response**:
  ```json
  {
    "jsonrpc": "2.0",
    "id": 1,
    "result": {
      "status": "ready",
      "version": "1.0.0",
      "supportedFeatures": ["tools", "mcp"]
    }
  }
  ```

### 3.2 工具清单发现 (`tools/list`)
* **Request**:
  ```json
  {
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/list",
    "params": {}
  }
  ```
* **Response**:
  ```json
  {
    "jsonrpc": "2.0",
    "id": 2,
    "result": {
      "tools": [
        {
          "name": "search_web",
          "description": "Search web pages",
          "inputSchema": { "type": "object", "properties": { "query": { "type": "string" } } }
        }
      ]
    }
  }
  ```

### 3.3 工具执行调用 (`tools/call`)
* **Request**:
  ```json
  {
    "jsonrpc": "2.0",
    "id": 3,
    "method": "tools/call",
    "params": {
      "name": "search_web",
      "arguments": { "query": "DeepSeek Desktop" }
    }
  }
  ```
* **Response**:
  ```json
  {
    "jsonrpc": "2.0",
    "id": 3,
    "result": {
      "content": [{ "type": "text", "text": "Results..." }]
    }
  }
  ```

---

## 4. 容错与生命周期管理

1. **心跳与看门狗（Heartbeat & Watchdog）**：
   - 主进程每隔 15 秒向 Worker 发送 `ping`，若 30 秒内无响应则判定为僵死并执行优雅重启。
2. **崩溃自愈（Self-Healing）**：
   - Worker 意外退出时触发 `[dsh-worker-exit]` 事件，主进程保留已知工具的桩代理，并在下次调用时尝试按需重拉 Worker。
3. **断路器（Circuit Breaker）**：
   - 单个插件若在 1 分钟内连续抛出 3 次致命错误，主进程自动将其标记为 `quarantined`（隔离状态），并在 UI 提示用户，避免持续冲击系统。
4. **按需懒加载（Lazy Loading）**：
   - 仅在主进程收到 AI Model 发起 Tool Call 时才真正激活对应的 Worker 实例。
