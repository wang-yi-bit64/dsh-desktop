# Model Gateway 设计备忘录 (RFC & Architecture Memo)

> **状态**：待开发（Backlog / RFC Phase）  
> **目标**：在 `dsh-desktop` 中构建统一的模型协议适配与工具调用治理网关，消除多模型提供商（OpenAI、DeepSeek、Gemini、Claude 等）之间的 Schema 差异与 Tool Calling 格式冲突。

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
