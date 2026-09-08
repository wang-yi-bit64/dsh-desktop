use std::time::Instant;
use dsh_model_gateway::{
    adapters::{ClaudeAdapter, GeminiAdapter, OpenAIAdapter},
    sanitizer::{sanitize_for_claude, sanitize_for_gemini, sanitize_for_openai},
    CanonicalTool, ModelProviderAdapter,
};
use serde_json::json;

fn main() {
    println!("=== Running dsh-desktop Model Gateway Performance Benchmarks ===");

    let tool_params = json!({
        "type": "object",
        "properties": {
            "query": { "type": "string" },
            "filters": {
                "type": "object",
                "properties": {
                    "category": { "type": "string" },
                    "tags": { "type": "array", "items": { "type": "string" } }
                }
            },
            "limit": { "type": "integer", "default": 10 }
        },
        "required": ["query"]
    });

    let iterations = 20_000;
    let start = Instant::now();
    for _ in 0..iterations {
        let tool = CanonicalTool::new("search_data_complex", "Benchmark complex nested tool conversion", tool_params.clone());
        let _ = tool.validate_name();
    }
    let elapsed = start.elapsed();
    println!(
        "Canonicalize Tool Schema: {} iterations in {:?} ({:.2} µs/op)",
        iterations,
        elapsed,
        (elapsed.as_micros() as f64) / (iterations as f64)
    );

    // 2. Benchmark Multi-Provider Sanitization
    let canonical = CanonicalTool {
        name: "execute_action".to_string(),
        description: "Action execution helper".to_string(),
        parameters: json!({
            "type": "object",
            "properties": {
                "target": { "type": "string" },
                "options": {
                    "type": "object",
                    "properties": {
                        "async_run": { "type": "boolean" },
                        "timeout": { "type": "integer" }
                    }
                }
            },
            "required": ["target"]
        }),
        strict: true,
        source_plugin: Some("test-plugin".to_string()),
    };

    let openai = OpenAIAdapter::default();
    let gemini = GeminiAdapter::default();
    let claude = ClaudeAdapter::default();

    let start = Instant::now();
    for _ in 0..iterations {
        let _ = sanitize_for_openai(&canonical.parameters, 0);
        let _ = sanitize_for_gemini(&canonical.parameters, 0);
        let _ = sanitize_for_claude(&canonical.parameters, 0);
        let _ = openai.transform_tool(&canonical);
        let _ = gemini.transform_tool(&canonical);
        let _ = claude.transform_tool(&canonical);
    }
    let elapsed = start.elapsed();
    println!(
        "Multi-Provider Sanitization & Adaptation: {} iterations in {:?} ({:.2} µs/op)",
        iterations,
        elapsed,
        (elapsed.as_micros() as f64) / (iterations as f64)
    );

    println!("=== Benchmarks Completed Successfully ===");
}
