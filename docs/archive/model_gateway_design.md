# Model Gateway 设计备忘录 (RFC & Architecture Memo)

> ## 🗄️ 已归档（2026-09-10）
>
> **该 crate 已从 workspace 移除并归档。** 执行的是
> `docs/dev-plan-disconnected-points.md` §4 决策点 3 的裁定：**冻结并归档**，不接线。
>
> | 归档时的事实 | 归档动作 |
> |---|---|
> | `crates/dsh-model-gateway/**` 实现完整、有单测与 benchmark，但**零运行时消费者** | crate 目录删除；`Cargo.toml` 的 members 与 `[workspace.dependencies]` 条目一并移除 |
> | 官方 dsh 自带模型适配器 | 本文档移入 `docs/archive/` |
>
> **为什么删而不是留**：不在 workspace 里的 crate 既不会被编译也不会被测试，
> 它的 Schema 方言适配会随官方接口演进而静默腐烂；而「代码写得不错，先留着」
> 正是本轮在清理的那类欠债。**恢复它的判断标准见下方原文的「退出条件」段**——
> 那三条依然有效，只是判定结果从「待定」变成了「归档」。
>
> 下文为归档时的原始设计文本，保留以便追溯设计意图。

> **状态（2026-09-10 校准）**：crate **已实现**（`crates/dsh-model-gateway`，含单测与
> `examples/benchmark.rs`），但**未接线、不在默认运行时路径上**。
>
> | 维度 | 事实 |
> |---|---|
> | 实现 | ✅ `CanonicalTool` 抽象、`anyOf`/`oneOf` 展开、`$ref` 解析、深度保护、OpenAI/Gemini/Claude 方言转换（`sanitize_for_*` + `adapters/`） |
> | 测试 | ✅ `cargo test -p dsh-model-gateway`、`cargo run --release -p dsh-model-gateway --example benchmark` |
> | 运行时接线 | ❌ 无消费者。`src-tauri` 曾声明该依赖但零引用，该依赖已于 2026-09-10 移除，以免对外呈现「壳层跑着第二套模型适配」的假象 |
> | 与官方关系 | 官方 dsh 自带模型适配器；本 crate 若接线，将构成**第二套适配逻辑**，需与官方接口同步演进 |
>
> **退出条件（满足任一即应归档本 crate 或删除）**：① 官方 dsh 覆盖了本 crate 所解决的
> 方言场景（尤其 Gemini 大写枚举、Claude `input_schema` 递归约束）；② 连续两个
> DSH 小版本迭代后仍无接线计划；③ 官方模型适配接口发生不兼容变更而本 crate 未同步。
>
> **接线前置（若决定启用）**：必须在本文件中登记——接线点（哪个进程、哪个函数）、
> 消费者（谁调用 `build_request` / `transform_tools`）、失败降级策略、以及
> 「官方覆盖后如何摘除」的回归验证方式；随后才可恢复 `src-tauri` 的依赖声明。
>
> **目标**：统一模型协议适配与工具调用治理网关，消除多模型提供商（OpenAI、DeepSeek、Gemini、Claude 等）之间的 Schema 差异与 Tool Calling 格式冲突。

---

## 1. 背景与核心问题

当前 DSH 直接将插件系统生成的 Tool Definition 与参数 Schema 透传给底层大模型 API。但在多模型生态中存在以下主要问题：

1. **JSON Schema 方言差异**：
   - **OpenAI / DeepSeek**：兼容标准 JSON Schema（如 `type: "object"`, `properties`, `required` 等）。
   - **Google Gemini**：仅支持 OpenAPI 3.0 的严格子集，不支持 `additionalProperties`、`$schema`、`oneOf`/`anyOf`/`allOf`，且 `type` 字段必须为大写枚举（如 `STRING`, `OBJECT`, `ARRAY`），否则报 `Invalid value at request.tools[0].function_declarations[...].parameters`。
   - **Anthropic Claude**：工具参数需通过 `input_schema` 传递，对递归 Schema 和部分高阶关键字有额外约束。
2. **缺乏统一 Token / Context 预检**：
   - 无法统一在请求发出前对 Prompt、历史上下文和 Tool 描述进行 Token 计算与截断。
3. **错误归因模糊**：
   - 当模型返回 400 Bad Request 时，难以快速定位是由于哪个插件生成的哪个 Tool Schema 触发了格式违例。

---

## 2. 目标架构与模块划分 (`crates/dsh-model-gateway`)

未来计划将网关实现为独立的 Rust 核心库 `crates/dsh-model-gateway`（或在 Headless 宿主内部作为子模块）：

```
┌─────────────────────────────────────────────────────────────┐
│                     DSH Agent Engine                        │
└──────────────────────────────┬──────────────────────────────┘
                               │ Canonical Tool Schema & Messages
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                 dsh-model-gateway (Rust)                    │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ 1. Canonical Schema Validator & Sanitizer             │  │
│  │    - 规范化参数结构 (去除不支持的 $schema / anyOf 等) │  │
│  │    - 字段重命名与安全字符校验 (满足 ^[a-zA-Z0-9_-]+$) │  │
│  └───────────────────────────┬───────────────────────────┘  │
│                              │                              │
│  ┌───────────────────────────▼───────────────────────────┐  │
│  │ 2. Provider Adapters                                  │  │
│  │    ├─ OpenAIAdapter (OpenAI, DeepSeek, vLLM, Ollama)  │  │
│  │    ├─ GeminiAdapter (严格 OpenAPI 3.0, 大写 Type)     │  │
│  │    └─ ClaudeAdapter (Anthropic Tool use 规范)         │  │
│  └───────────────────────────┬───────────────────────────┘  │
│                              │                              │
│  ┌───────────────────────────▼───────────────────────────┐  │
│  │ 3. Token Preflight & Cost Metering                    │  │
│  │    - Tiktoken / BPE 预估，防超长截断                  │  │
│  └───────────────────────────────────────────────────────┘  │
└──────────────────────────────┬──────────────────────────────┘
                               │ Target Provider Request
                               ▼
                   Upstream Model APIs
```

---

## 3. 标准规范设计 (Canonical Tool Definition)

### 3.1 统一工具结构
```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CanonicalTool {
    /// 工具唯一标识符（符合 ^[a-zA-Z0-9_-]{1,64}$）
    pub name: String,
    /// 工具用途描述
    pub description: String,
    /// 规范化的 JSON Schema 参数定义
    pub parameters: serde_json::Value,
    /// 所属插件或来源标识（用于故障追踪与归因）
    pub source_plugin: Option<String>,
}
```

### 3.2 适配器接口契约 (ProviderAdapter Trait)
```rust
pub trait ModelProviderAdapter: Send + Sync {
    /// 提供商唯一标识（如 "openai", "gemini", "anthropic"）
    fn provider_id(&self) -> &'static str;

    /// 将 CanonicalTool 转换为目标提供商能够接受的 Schema
    fn transform_tool(&self, tool: &CanonicalTool) -> Result<serde_json::Value, TransformError>;

    /// 将通用消息与工具调用转换为提供商原生 HTTP Payload
    fn build_request_payload(
        &self,
        model: &str,
        messages: &[serde_json::Value],
        tools: &[CanonicalTool],
    ) -> Result<serde_json::Value, TransformError>;
}
```

---

## 4. 实施阶段规划 (待开发线路图)

1. **第一期（Schema 清理与校验器）**：
   - 提取各插件的 JSON Schema，并在内存中进行清洗（如移除 `additionalProperties: false`，规范化类型定义）。
2. **第二期（Gemini / OpenAI 适配器落地）**：
   - 实现 Gemini 严格模式转换，解决 `Invalid value at request.tools`。
3. **第三期（Token 预检与审计日志）**：
   - 在 Rust 层实现快速 Token 估算，并提供每次调用的请求/响应日志结构化归档。
