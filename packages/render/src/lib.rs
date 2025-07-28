use getrandom as _; // ← This enables browser crypto.getRandomValues()
use minijinja::{Environment, UndefinedBehavior};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::Map;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use wasm_bindgen::prelude::*;

const TEMPLATE_KEY: &str = "template:01JVK339CW6Q67VAMXCA7XAK7D";

static COMPONENT_REGISTRY: Lazy<Mutex<HashMap<String, Value>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static ENV: Lazy<Mutex<Environment<'static>>> = Lazy::new(|| Mutex::new(Environment::new()));

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console)]
    fn log(s: &str);
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct TemplateSource {
    name: String,
    source: String,
    components: Vec<String>,
}

type Entity = Map<String, Value>;

#[derive(Serialize, Deserialize, Debug, PartialEq)]
enum CompileErrorType {
    ParseError,
    MissingDependency,
    CompileError,
    SchemaValidationError,
}

#[derive(Serialize, Deserialize, Debug)]
struct CompileError {
    error_type: CompileErrorType,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    missing_dependencies: Option<Vec<String>>,
}

#[derive(Serialize, Deserialize, Debug, PartialEq)]
enum RenderErrorType {
    ParseError,
    RenderError,
}

#[derive(Serialize, Deserialize, Debug)]
struct RenderError {
    error_type: RenderErrorType,
    message: String,
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(tag = "type")]
enum CompileResult {
    Success,
    Error { error: CompileError },
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(tag = "type")]
enum RenderResult {
    Success { result: String },
    Error { error: RenderError },
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(tag = "type")]
enum RegisterResult {
    Success,
    Error { message: String },
}

fn validate_schema(_schema: &Value) -> Result<(), String> {
    // let _validator =
    //     jsonschema::validator_for(&schema).map_err(|e| format!("Invalid schema: {}", e))?;
    Ok(())
}

#[wasm_bindgen]
pub fn register_component(name: String, schema: JsValue) -> Result<(), JsValue> {
    let schema: Value = serde_wasm_bindgen::from_value(schema)
        .map_err(|e| JsValue::from_str(&format!("Failed to parse schema: {}", e)))?;

    match validate_schema(&schema) {
        Ok(_) => {
            let mut registry = COMPONENT_REGISTRY.lock().unwrap();
            registry.insert(name, schema);
            Ok(())
        }
        Err(e) => Err(JsValue::from_str(&format!("Invalid schema: {}", e))),
    }
}

fn validate_template_variables(
    components: &Vec<String>,
    vars: &HashSet<String>,
) -> Result<(), String> {
    let registry = COMPONENT_REGISTRY.lock().unwrap();
    let schemas: Vec<Value> = components
        .iter()
        .filter_map(|component| registry.get(component).map(|schema| schema.clone()))
        .collect();

    for var in vars {
        let parts: Vec<&str> = var.split('.').collect();
        let exists = schemas.iter().any(|schema| {
            let mut current = schema;
            for (i, part) in parts.iter().enumerate() {
                if let Some(properties) = current.get("properties") {
                    if let Some(props) = properties.as_object() {
                        if let Some(prop) = props.get(*part) {
                            if i == parts.len() - 1 {
                                return true;
                            }
                            current = prop;
                            continue;
                        }
                    }
                }
                return false;
            }
            false
        });

        if !exists {
            return Err(format!("Variable '{var}' is not allowed by schema"));
        }
    }

    Ok(())
}

#[wasm_bindgen]
pub fn compile_templates(templates: JsValue) -> Result<(), JsValue> {
    let entities: Vec<Entity> = serde_wasm_bindgen::from_value(templates)
        .map_err(|e| JsValue::from_str(&format!("Failed to parse templates: {}", e)))?;

    let templates: Vec<TemplateSource> = entities
        .iter()
        .filter_map(|e| {
            log(&format!("template entity: {:#?}", e));
            let template = e.get(TEMPLATE_KEY).and_then(|v| v.as_object())?;
            let name = template.get("name").and_then(|v| v.as_str())?;
            let source = template.get("source").and_then(|v| v.as_str())?;
            let components = template.get("components").and_then(|v| v.as_array())?;
            let components = components
                .iter()
                .filter_map(|v| v.as_str())
                .map(|s| s.to_string())
                .collect();
            Some(TemplateSource {
                name: name.to_string(),
                source: source.to_string(),
                components,
            })
        })
        .collect();

    log(&format!("templates: {:#?}", templates));

    let mut env = ENV.lock().unwrap();
    env.set_undefined_behavior(UndefinedBehavior::Strict);

    for t in &templates {
        match env.add_template_owned(t.name.clone(), t.source.clone()) {
            Ok(_) => {
                let template = env.get_template(&t.name).unwrap();
                let vars = template.undeclared_variables(true);
                if let Err(e) = validate_template_variables(&t.components, &vars) {
                    return Err(JsValue::from_str(&format!(
                        "Template validation error: {}",
                        e
                    )));
                }
                log(&format!("template: {:#?}", t));
                log(&format!("vars: {:#?}", vars));
            }
            Err(e) => {
                let deps = if e.to_string().contains("not found") {
                    Some(
                        e.to_string()
                            .split("not found")
                            .filter_map(|s| {
                                let s = s.trim();
                                if s.is_empty() {
                                    None
                                } else {
                                    Some(s.to_string())
                                }
                            })
                            .collect(),
                    )
                } else {
                    None
                };

                let error = CompileError {
                    error_type: if deps.is_some() {
                        CompileErrorType::MissingDependency
                    } else {
                        CompileErrorType::CompileError
                    },
                    message: e.to_string(),
                    missing_dependencies: deps,
                };

                return Err(serde_wasm_bindgen::to_value(&CompileResult::Error { error }).unwrap());
            }
        }
    }

    Ok(())
}

#[wasm_bindgen]
pub fn render_template(name: String, context: JsValue) -> Result<String, JsValue> {
    log(&format!("name: {}", name));

    let ctx: Value = serde_wasm_bindgen::from_value(context)
        .map_err(|e| JsValue::from_str(&format!("Invalid context: {}", e)))?;

    let env = ENV.lock().unwrap();
    let tmpl = env
        .get_template(&name)
        .map_err(|_| JsValue::from_str("Template not found"))?;

    tmpl.render(ctx)
        .map_err(|e| JsValue::from_str(&format!("Failed to render template: {}", e)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::de::DeserializeOwned;
    use serde_json::json;
    use wasm_bindgen_test::*;

    wasm_bindgen_test_configure!(run_in_browser);

    fn extract_vars_from_template(template: &str) -> HashSet<String> {
        let mut env = Environment::new();
        env.add_template_owned("template", template).unwrap();
        let template = env.get_template("template").unwrap();
        template.undeclared_variables(true)
    }

    fn setup_test_templates() -> Vec<Entity> {
        let name_component = (
            "name_component".to_string(),
            json!({
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                },
                "required": ["name"]
            }),
        );

        register_component(
            name_component.0,
            serde_wasm_bindgen::to_value(&name_component.1).unwrap(),
        )
        .unwrap();

        let condition_component = (
            "condition_component".to_string(),
            json!({
                "type": "object",
                "properties": {
                    "condition": {"type": "boolean"},
                },
                "required": ["condition"]
            }),
        );

        register_component(
            condition_component.0,
            serde_wasm_bindgen::to_value(&condition_component.1).unwrap(),
        )
        .unwrap();

        let templates = vec![
            TemplateSource {
                name: "test1".to_string(),
                source: "Hello {{ name }}!".to_string(),
                components: vec!["name_component".to_string()],
            },
            TemplateSource {
                name: "test2".to_string(),
                source: "{% if condition %}True{% else %}False{% endif %}".to_string(),
                components: vec!["condition_component".to_string()],
            },
        ];

        templates
            .iter()
            .map(|t| {
                let mut entity = Entity::new();
                entity.insert(TEMPLATE_KEY.to_string(), json!(t));
                entity
            })
            .collect()
    }

    #[wasm_bindgen_test]
    fn test_register_component_success() {
        let component = (
            "test_button".to_string(),
            json!({
                "type": "object",
                "properties": {
                    "label": {"type": "string"},
                    "url": {"type": "string"}
                },
                "required": ["label"]
            }),
        );

        register_component(
            component.0,
            serde_wasm_bindgen::to_value(&component.1).unwrap(),
        )
        .unwrap();

        let registry = COMPONENT_REGISTRY.lock().unwrap();
        assert!(registry.contains_key("test_button"));
    }

    #[wasm_bindgen_test]
    fn test_validate_template_variables_authorised() {
        let component = (
            "test_button".to_string(),
            json!({
                "type": "object",
                "properties": {
                    "label": {"type": "string"},
                    "url": {"type": "string"}
                },
                "required": ["label"]
            }),
        );

        register_component(
            component.0,
            serde_wasm_bindgen::to_value(&component.1).unwrap(),
        )
        .unwrap();

        let template = TemplateSource {
            name: "button".into(),
            source: "{{ label }}".into(),
            components: vec!["test_button".to_string()],
        };
        let vars = extract_vars_from_template(&template.source);
        assert_eq!(
            validate_template_variables(&template.components, &vars),
            Ok(())
        );
    }

    #[wasm_bindgen_test]
    fn test_validate_template_variables_unauthorised() {
        let template = TemplateSource {
            name: "button".into(),
            source: "{{ unauthorised_variable }}".into(),
            components: vec![],
        };

        let vars = extract_vars_from_template(&template.source);
        let err = validate_template_variables(&template.components, &vars).unwrap_err();
        assert!(err.contains("unauthorised_variable"));
    }

    #[wasm_bindgen_test]
    fn test_compile_templates() {
        let templates = setup_test_templates();
        let result = compile_templates(serde_wasm_bindgen::to_value(&templates).unwrap());
        assert!(result.is_ok());
    }

    #[wasm_bindgen_test]
    fn test_render_template() {
        let templates = setup_test_templates();
        compile_templates(serde_wasm_bindgen::to_value(&templates).unwrap()).unwrap();

        let context = json!({"name": "World"});
        let result = render_template(
            "test1".to_string(),
            serde_wasm_bindgen::to_value(&context).unwrap(),
        );

        assert_eq!(result.unwrap(), "Hello World!");
    }

    #[wasm_bindgen_test]
    fn test_render_template_with_condition() {
        let templates = setup_test_templates();
        compile_templates(serde_wasm_bindgen::to_value(&templates).unwrap()).unwrap();

        let context = json!({"condition": true});
        let result = render_template(
            "test2".to_string(),
            serde_wasm_bindgen::to_value(&context).unwrap(),
        );

        assert_eq!(result.unwrap(), "True");
    }

    #[wasm_bindgen_test]
    fn test_render_template_with_false_condition() {
        let templates = setup_test_templates();
        compile_templates(serde_wasm_bindgen::to_value(&templates).unwrap()).unwrap();

        let context = json!({"condition": false});
        let result = render_template(
            "test2".to_string(),
            serde_wasm_bindgen::to_value(&context).unwrap(),
        );

        assert_eq!(result.unwrap(), "False");
    }

    #[wasm_bindgen_test]
    fn test_render_nonexistent_template() {
        let result = render_template(
            "nonexistent".to_string(),
            serde_wasm_bindgen::to_value(&json!({})).unwrap(),
        );

        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .as_string()
            .unwrap()
            .contains("Template not found"));
    }
}
