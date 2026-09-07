//! Comprehensive unit and integration tests for `dsh-model-gateway`.

use dsh_model_gateway::{
    adapters::{ClaudeAdapter, GeminiAdapter, ModelProviderAdapter, OpenAIAdapter, TransformError},
    sanitizer::{sanitize_for_gemini, sanitize_for_openai, sanitize_schema, TargetProvider},
    schema::{CanonicalTool, JsonSchema, ParameterProperty, SchemaType},
    ModelGateway,
};
use serde_json::json;
use std::collections::BTreeMap;

#[test]
fn test_schema_serialization_and_deserialization() {
    let mut properties = BTreeMap::new();
    properties.insert(
        "query".to_string(),
        ParameterProperty {
            property_type: Some(SchemaType::String),
            description: Some("Search keywords".to_string()),
            ..Default::default()
        },
    );
    properties.insert(
        "limit".to_string(),
        ParameterProperty {
            property_type: Some(SchemaType::Integer),
            description: Some("Max items".to_string()),
            default: Some(json!(10)),
            ..Default::default()
        },
    );

    let schema = JsonSchema {
        schema_dialect: Some("http://json-schema.org/draft-07/schema#".to_string()),
        schema_type: SchemaType::Object,
        description: Some("Search query parameters".to_string()),
        properties,
        required: vec!["query".to_string()],
        additional_properties: Some(false),
        ..Default::default()
    };

    let serialized = serde_json::to_string(&schema).expect("Serialize schema");
    assert!(serialized.contains("draft-07"));
    assert!(serialized.contains("Search keywords"));

    let deserialized: JsonSchema = serde_json::from_str(&serialized).expect("Deserialize schema");
    assert_eq!(deserialized.schema_type, SchemaType::Object);
    assert_eq!(deserialized.required, vec!["query"]);
    assert_eq!(deserialized.properties.len(), 2);
}

#[test]
fn test_canonical_tool_validation() {
    let valid_tool = CanonicalTool::new(
        "fetch_weather_report",
        "Gets weather for city",
        json!({
            "type": "object",
            "properties": {
                "city": {"type": "string"}
            },
            "required": ["city"]
        }),
    );
    assert!(valid_tool.validate_name().is_ok());

    let empty_tool = CanonicalTool::new("", "Empty name", json!({}));
    assert!(empty_tool.validate_name().is_err());

    let invalid_chars_tool = CanonicalTool::new("bad.tool!name", "Invalid chars", json!({}));
    assert!(invalid_chars_tool.validate_name().is_err());

    let long_tool = CanonicalTool::new("a".repeat(65), "Tool name too long", json!({}));
    assert!(long_tool.validate_name().is_err());
}

#[test]
fn test_sanitizer_openai() {
    let complex_schema = json!({
        "$schema": "http://json-schema.org/draft-07/schema#",
        "$id": "https://example.com/schema.json",
        "type": "object",
        "properties": {
            "city": {
                "type": ["string", "null"],
                "description": "City name"
            },
            "options": {
                "anyOf": [
                    {
                        "type": "object",
                        "properties": {
                            "units": {"type": "string", "enum": ["metric", "imperial"]}
                        }
                    },
                    {
                        "type": "null"
                    }
                ]
            }
        },
        "required": ["city"]
    });

    let sanitized = sanitize_for_openai(&complex_schema, 0).expect("Sanitize OpenAI");
    assert!(sanitized.get("$schema").is_none());
    assert!(sanitized.get("$id").is_none());
    assert_eq!(sanitized["properties"]["city"]["type"], "string");
    assert_eq!(sanitized["properties"]["options"]["type"], "object");
    assert_eq!(
        sanitized["properties"]["options"]["properties"]["units"]["type"],
        "string"
    );
}

#[test]
fn test_sanitizer_gemini() {
    let complex_schema = json!({
        "$schema": "http://json-schema.org/draft-07/schema#",
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "Search text"
            },
            "tags": {
                "type": "array",
                "items": {
                    "type": "string"
                }
            },
            "filter": {
                "anyOf": [
                    {
                        "type": "object",
                        "properties": {
                            "created_after": {"type": "string"}
                        }
                    },
                    {
                        "type": "null"
                    }
                ]
            }
        },
        "required": ["query", "non_existent_prop"],
        "additionalProperties": false
    });

    let sanitized = sanitize_for_gemini(&complex_schema, 0).expect("Sanitize Gemini");
    assert_eq!(sanitized["type"], "OBJECT");
    assert!(sanitized.get("$schema").is_none());
    assert!(sanitized.get("additionalProperties").is_none());

    // Type must be uppercase
    assert_eq!(sanitized["properties"]["query"]["type"], "STRING");
    assert_eq!(sanitized["properties"]["tags"]["type"], "ARRAY");
    assert_eq!(sanitized["properties"]["tags"]["items"]["type"], "STRING");

    // anyOf collapsed
    assert_eq!(sanitized["properties"]["filter"]["type"], "OBJECT");
    assert_eq!(
        sanitized["properties"]["filter"]["properties"]["created_after"]["type"],
        "STRING"
    );

    // Required filtered to existing properties only
    assert_eq!(sanitized["required"], json!(["query"]));
}

#[test]
fn test_openai_adapter_transform() {
    let tool = CanonicalTool::new(
        "calculator",
        "Calculates math expressions",
        json!({
            "type": "object",
            "properties": {
                "expr": {"type": "string"}
            },
            "required": ["expr"]
        }),
    )
    .with_strict(true);

    let adapter = OpenAIAdapter::new();
    let transformed = adapter
        .transform_tool(&tool)
        .expect("Transform OpenAI tool");

    assert_eq!(transformed["type"], "function");
    assert_eq!(transformed["function"]["name"], "calculator");
    assert_eq!(
        transformed["function"]["description"],
        "Calculates math expressions"
    );
    assert_eq!(transformed["function"]["strict"], true);
    assert_eq!(
        transformed["function"]["parameters"]["properties"]["expr"]["type"],
        "string"
    );

    // Request payload test
    let messages = vec![json!({"role": "user", "content": "What is 2 + 2?"})];
    let payload = adapter
        .build_request_payload("gpt-4o", &messages, &[tool])
        .expect("Build OpenAI payload");
    assert_eq!(payload["model"], "gpt-4o");
    assert_eq!(payload["messages"].as_array().unwrap().len(), 1);
    assert_eq!(payload["tools"].as_array().unwrap().len(), 1);
}

#[test]
fn test_gemini_adapter_transform() {
    let tool = CanonicalTool::new(
        "web_search",
        "Searches the web",
        json!({
            "type": "object",
            "properties": {
                "query": {"type": "string"}
            },
            "required": ["query"]
        }),
    );

    let adapter = GeminiAdapter::new();
    let transformed = adapter
        .transform_tool(&tool)
        .expect("Transform Gemini tool");

    assert_eq!(transformed["name"], "web_search");
    assert_eq!(transformed["parameters"]["type"], "OBJECT");
    assert_eq!(
        transformed["parameters"]["properties"]["query"]["type"],
        "STRING"
    );

    let contents = vec![json!({"parts": [{"text": "Search for Rust 2024"}]})];
    let payload = adapter
        .build_request_payload("gemini-1.5-pro", &contents, &[tool])
        .expect("Build Gemini payload");

    assert_eq!(
        payload["tools"][0]["functionDeclarations"][0]["name"],
        "web_search"
    );
}

#[test]
fn test_claude_adapter_transform() {
    let tool = CanonicalTool::new(
        "file_reader",
        "Reads file from disk",
        json!({
            "type": "object",
            "properties": {
                "path": {"type": "string"}
            },
            "required": ["path"]
        }),
    );

    let adapter = ClaudeAdapter::new();
    let transformed = adapter
        .transform_tool(&tool)
        .expect("Transform Claude tool");

    assert_eq!(transformed["name"], "file_reader");
    assert_eq!(transformed["input_schema"]["type"], "object");
    assert_eq!(
        transformed["input_schema"]["properties"]["path"]["type"],
        "string"
    );

    let messages = vec![json!({"role": "user", "content": "Read foo.txt"})];
    let payload = adapter
        .build_request_payload("claude-3-7-sonnet-20250219", &messages, &[tool])
        .expect("Build Claude payload");

    assert_eq!(payload["model"], "claude-3-7-sonnet-20250219");
    assert_eq!(payload["tools"][0]["name"], "file_reader");
}

#[test]
fn test_model_gateway_facade() {
    let gateway = ModelGateway::new();

    let tool = CanonicalTool::new(
        "grep_search",
        "Grep codebase",
        json!({
            "type": "object",
            "properties": {
                "pattern": {"type": "string"}
            },
            "required": ["pattern"]
        }),
    );

    // Test OpenAI via gateway
    let openai_tools = gateway
        .transform_tools("openai", std::slice::from_ref(&tool))
        .expect("Gateway transform OpenAI");
    assert_eq!(openai_tools[0]["type"], "function");
    assert_eq!(openai_tools[0]["function"]["name"], "grep_search");

    // Test DeepSeek alias via gateway
    let deepseek_tools = gateway
        .transform_tools("deepseek", std::slice::from_ref(&tool))
        .expect("Gateway transform DeepSeek");
    assert_eq!(deepseek_tools[0]["type"], "function");

    // Test Gemini via gateway
    let gemini_tools = gateway
        .transform_tools("gemini", std::slice::from_ref(&tool))
        .expect("Gateway transform Gemini");
    assert_eq!(
        gemini_tools[0]["functionDeclarations"][0]["name"],
        "grep_search"
    );

    // Test Claude via gateway
    let claude_tools = gateway
        .transform_tools("claude", std::slice::from_ref(&tool))
        .expect("Gateway transform Claude");
    assert_eq!(claude_tools[0]["name"], "grep_search");

    // Test unknown provider error
    let unknown_err = gateway
        .transform_tools("unknown_provider", std::slice::from_ref(&tool))
        .unwrap_err();
    assert_eq!(
        unknown_err,
        TransformError::Unsupported(
            "Provider 'unknown_provider' is not registered in gateway".to_string()
        )
    );
}

#[test]
fn test_sanitize_schema_enum_and_depth() {
    let schema_with_null_enums = json!({
        "type": "object",
        "properties": {
            "mode": {
                "type": "string",
                "enum": ["fast", "precise", null]
            }
        }
    });

    let sanitized_gemini = sanitize_schema(&schema_with_null_enums, TargetProvider::Gemini)
        .expect("Sanitize enum for Gemini");
    assert_eq!(
        sanitized_gemini["properties"]["mode"]["enum"],
        json!(["fast", "precise"])
    );
}
