use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use thiserror::Error;

const DEFAULT_CONFIG_FILE: &str = ".titan/config.toml";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AutonomyMode {
    Supervised,
    #[default]
    Collaborative,
    Autonomous,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TitanConfig {
    pub workspace_dir: PathBuf,
    pub log_level: String,
    pub mode: AutonomyMode,
    #[serde(default)]
    pub model: ModelConfig,
    #[serde(default)]
    pub discord: DiscordConfig,
    #[serde(default)]
    pub chat: ChatConfig,
    #[serde(default)]
    pub security: SecurityConfig,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelProvider {
    OpenAi,
    Anthropic,
    #[default]
    Ollama,
    Custom,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelConfig {
    #[serde(default)]
    pub provider: ModelProvider,
    pub model_id: String,
    pub endpoint: Option<String>,
    pub api_key_env: Option<String>,
}

impl Default for ModelConfig {
    fn default() -> Self {
        Self {
            provider: ModelProvider::Ollama,
            model_id: "llama3.2:latest".to_string(),
            endpoint: Some("http://127.0.0.1:11434".to_string()),
            api_key_env: None,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DiscordConfig {
    #[serde(default)]
    pub enabled: bool,
    pub token: Option<String>,
    pub default_channel_id: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActivationMode {
    #[default]
    Always,
    Mention,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatConfig {
    #[serde(default)]
    pub activation_mode: ActivationMode,
    #[serde(default)]
    pub allowlist: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SecurityConfig {
    #[serde(default = "default_true")]
    pub yolo_bypass_path_guard: bool,
}

impl Default for ChatConfig {
    fn default() -> Self {
        Self {
            activation_mode: ActivationMode::Always,
            allowlist: Vec::new(),
        }
    }
}

impl Default for SecurityConfig {
    fn default() -> Self {
        Self {
            yolo_bypass_path_guard: true,
        }
    }
}

impl Default for TitanConfig {
    fn default() -> Self {
        let workspace_dir = dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("titan-workspace");

        Self {
            workspace_dir,
            log_level: "info".to_string(),
            mode: AutonomyMode::default(),
            model: ModelConfig::default(),
            discord: DiscordConfig::default(),
            chat: ChatConfig::default(),
            security: SecurityConfig::default(),
        }
    }
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("failed to read config at {path}: {source}")]
    ReadFailed {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("failed to write config at {path}: {source}")]
    WriteFailed {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("failed to parse config at {path}: {source}")]
    ParseFailed {
        path: PathBuf,
        source: toml::de::Error,
    },
    #[error("failed to serialize default config: {0}")]
    SerializeFailed(#[from] toml::ser::Error),
    #[error("config has invalid value: {0}")]
    ValidationFailed(String),
}

impl TitanConfig {
    pub fn resolve_path() -> PathBuf {
        if let Ok(path) = env::var("TITAN_CONFIG") {
            return PathBuf::from(path);
        }

        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(DEFAULT_CONFIG_FILE)
    }

    pub fn load(path: &Path) -> Result<Self, ConfigError> {
        let raw = fs::read_to_string(path).map_err(|source| ConfigError::ReadFailed {
            path: path.to_path_buf(),
            source,
        })?;
        toml::from_str(&raw).map_err(|source| ConfigError::ParseFailed {
            path: path.to_path_buf(),
            source,
        })
    }

    pub fn save(&self, path: &Path) -> Result<(), ConfigError> {
        let raw = toml::to_string_pretty(self)?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|source| ConfigError::WriteFailed {
                path: parent.to_path_buf(),
                source,
            })?;
        }
        fs::write(path, raw).map_err(|source| ConfigError::WriteFailed {
            path: path.to_path_buf(),
            source,
        })?;
        Ok(())
    }

    pub fn load_or_create() -> Result<(Self, PathBuf, bool), ConfigError> {
        let path = Self::resolve_path();
        if path.exists() {
            let cfg = Self::load(&path)?;
            return Ok((cfg, path, false));
        }

        let cfg = Self::default();
        cfg.save(&path)?;
        Ok((cfg, path, true))
    }

    pub fn validate_and_prepare(&self) -> Result<(), ConfigError> {
        if self.log_level.trim().is_empty() {
            return Err(ConfigError::ValidationFailed(
                "log_level cannot be empty".to_string(),
            ));
        }
        if self.model.model_id.trim().is_empty() {
            return Err(ConfigError::ValidationFailed(
                "model.model_id cannot be empty".to_string(),
            ));
        }
        if let Some(endpoint) = &self.model.endpoint
            && endpoint.trim().is_empty()
        {
            return Err(ConfigError::ValidationFailed(
                "model.endpoint cannot be empty if set".to_string(),
            ));
        }
        fs::create_dir_all(&self.workspace_dir).map_err(|source| ConfigError::WriteFailed {
            path: self.workspace_dir.clone(),
            source,
        })?;
        Ok(())
    }
}
